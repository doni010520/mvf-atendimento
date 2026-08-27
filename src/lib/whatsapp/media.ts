import type { createServiceClient } from "@/lib/supabase/server";
import { getProvider } from "./index";
import { transcribeAudio } from "./transcribe";
import type { Channel } from "@/lib/types";

type DB = ReturnType<typeof createServiceClient>;

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "image/bmp": "bmp", "image/tiff": "tiff", "image/heic": "heic", "image/svg+xml": "svg",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "weba", "audio/amr": "amr",
  "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov", "video/webm": "webm",
  "video/x-matroska": "mkv", "video/x-msvideo": "avi",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/zip": "zip", "application/x-zip-compressed": "zip",
  "application/x-rar-compressed": "rar", "application/vnd.rar": "rar",
  "application/x-7z-compressed": "7z", "application/gzip": "gz",
  "application/rtf": "rtf", "application/json": "json", "application/xml": "xml",
  "text/plain": "txt", "text/csv": "csv", "text/xml": "xml", "text/html": "html",
};

/**
 * Extensao a partir da ASSINATURA dos bytes. E a fonte mais confiavel quando o
 * provedor manda "application/octet-stream" (o caso que gerava arquivo .bin).
 */
function extFromBytes(buf: Buffer): string | undefined {
  const b = buf.subarray(0, 16);
  const hex = b.toString("hex");
  if (hex.startsWith("25504446")) return "pdf";            // %PDF
  if (hex.startsWith("d0cf11e0a1b11ae1")) return "xls";     // OLE2 (xls/doc/ppt antigos)
  if (hex.startsWith("504b0304")) return "xlsx";            // ZIP (ooxml/odf/zip)
  if (hex.startsWith("ffd8ff")) return "jpg";
  if (hex.startsWith("89504e47")) return "png";
  if (hex.startsWith("47494638")) return "gif";
  if (b.subarray(0, 4).toString() === "RIFF") return b.subarray(8, 12).toString() === "WEBP" ? "webp" : "wav";
  if (hex.startsWith("1a45dfa3")) return "webm";
  if (b.subarray(4, 8).toString() === "ftyp") return "mp4";
  if (hex.startsWith("494433") || hex.startsWith("fffb")) return "mp3";
  if (hex.startsWith("4f676753")) return "ogg";             // OggS
  if (hex.startsWith("52617221")) return "rar";
  if (hex.startsWith("377abcaf")) return "7z";
  return undefined;
}

/** Extensao do nome original ("orcamento.xls" -> "xls"). */
function extFromName(name?: string): string | undefined {
  const e = (name ?? "").split("?")[0].split("/").pop()?.split(".").pop()?.toLowerCase();
  return e && /^[a-z0-9]{2,5}$/.test(e) && e !== "bin" ? e : undefined;
}

/**
 * Decide a extensao do arquivo. Ordem: mimetype conhecido -> nome original ->
 * assinatura dos bytes -> extensao da URL. So cai em "bin" se tudo falhar.
 * ZIP generico e OLE2 sao ambiguos (xlsx/docx, xls/doc): o nome original manda.
 */
function pickExt(ct: string, fileName?: string, buf?: Buffer, url?: string): string {
  const byName = extFromName(fileName);
  const byMime = EXT[ct.split(";")[0].trim().toLowerCase()];
  if (byMime) return byMime;
  if (byName) return byName;
  const bySig = buf ? extFromBytes(buf) : undefined;
  if (bySig) return bySig;
  return extFromName(url) || "bin";
}
/**
 * Baixa a mídia recebida (descriptografada pela UAZAPI), re-hospeda no bucket
 * público "media" do Supabase e retorna a URL final + transcrição (áudio).
 * Best-effort: se falhar, devolve a URL crua da UAZAPI (que costuma ser pública).
 *
 * A UAZAPI às vezes não devolve transcrição (campo vazio) — quando isso
 * acontece com um áudio, a IA fica sem nenhum conteúdo pra processar e o bot
 * repete a última pergunta em loop (ex.: cliente manda vários áudios com o
 * CPF e o bot nunca entende). Por isso, para áudio sem transcrição do
 * provedor, rodamos Whisper por conta própria como reforço — o mesmo
 * mecanismo que a Meta já usa nativamente.
 */
export async function storeInboundMedia(
  db: DB,
  channel: Channel,
  externalId: string | undefined,
  contentType?: string,
  fileNameHint?: string,
): Promise<{ url?: string; transcription?: string; name?: string }> {
  if (!externalId) return {};
  const provider = getProvider(channel);
  if (!provider.downloadMedia) return {};

  const { url, buffer, mimetype, transcription, fileName } = await provider
    .downloadMedia(externalId)
    .catch(() => ({}) as { url?: string; buffer?: Buffer; mimetype?: string; transcription?: string; fileName?: string });
  const original = fileNameHint || fileName;
  const safeId = externalId.replace(/[^a-zA-Z0-9]/g, "").slice(-40);
  // Nome final visto pelo atendente: o do cliente, ja com extensao garantida.
  const finalName = (ext: string) => {
    const base = (original ?? "").split("/").pop()?.split("\\").pop()?.trim();
    if (!base) return `${safeId}.${ext}`;
    const clean = base.replace(/[\r\n"]/g, "").replace(/\.bin$/i, "");
    return extFromName(clean) ? clean : `${clean}.${ext}`;
  };

  // Meta: os bytes ja vieram (a URL da Graph API exige auth). Sobe direto no Storage.
  if (buffer) {
    try {
      const ct = mimetype || "application/octet-stream";
      const ext = pickExt(ct, original, buffer);
      const path = `${channel.organization_id}/${safeId}.${ext}`;
      const { error } = await db.storage.from("media").upload(path, buffer, { contentType: ct, upsert: true });
      if (!error) return { url: db.storage.from("media").getPublicUrl(path).data.publicUrl, transcription, name: finalName(ext) };
    } catch { /* segue sem url */ }
    return { transcription, name: original };
  }

  if (!url) return { transcription, name: original };

  // UAZAPI: URL publica -> baixa e re-hospeda.
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get("content-type") || mimetype || "application/octet-stream";
      // UAZAPI as vezes nao transcreve (campo vazio) - reforco via Whisper.
      const finalTranscription = transcription
        || (contentType === "audio" ? await transcribeAudio(buf, ct).catch(() => undefined) : undefined);
      const ext = pickExt(ct, original, buf, url);
      const path = `${channel.organization_id}/${safeId}.${ext}`;
      const { error } = await db.storage
        .from("media")
        .upload(path, buf, { contentType: ct, upsert: true });
      if (!error) {
        return {
          url: db.storage.from("media").getPublicUrl(path).data.publicUrl,
          transcription: finalTranscription,
          name: finalName(ext),
        };
      }
      return { url, transcription: finalTranscription, name: finalName(ext) };
    }
  } catch {
    /* mantem a URL crua da UAZAPI */
  }
  return { url, transcription, name: original };
}
