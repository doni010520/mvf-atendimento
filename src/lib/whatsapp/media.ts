import type { createServiceClient } from "@/lib/supabase/server";
import { getProvider } from "./index";
import { transcribeAudio } from "./transcribe";
import type { Channel } from "@/lib/types";

type DB = ReturnType<typeof createServiceClient>;

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
};

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
): Promise<{ url?: string; transcription?: string }> {
  if (!externalId) return {};
  const provider = getProvider(channel);
  if (!provider.downloadMedia) return {};

  const { url, buffer, mimetype, transcription } = await provider
    .downloadMedia(externalId)
    .catch(() => ({}) as { url?: string; buffer?: Buffer; mimetype?: string; transcription?: string });
  const safeId = externalId.replace(/[^a-zA-Z0-9]/g, "").slice(-40);

  // Meta: os bytes já vieram (a URL da Graph API exige auth). Sobe direto no Storage.
  if (buffer) {
    try {
      const ct = mimetype || "application/octet-stream";
      const ext = EXT[ct.split(";")[0]] || "bin";
      const path = `${channel.organization_id}/${safeId}.${ext}`;
      const { error } = await db.storage.from("media").upload(path, buffer, { contentType: ct, upsert: true });
      if (!error) return { url: db.storage.from("media").getPublicUrl(path).data.publicUrl, transcription };
    } catch { /* segue sem url */ }
    return { transcription };
  }

  if (!url) return { transcription };

  // UAZAPI: URL pública → baixa e re-hospeda.
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get("content-type") || mimetype || "application/octet-stream";
      // UAZAPI às vezes não transcreve (campo vazio) — reforço via Whisper.
      const finalTranscription = transcription
        || (contentType === "audio" ? await transcribeAudio(buf, ct).catch(() => undefined) : undefined);
      const ext = EXT[ct.split(";")[0]] || (url.split(".").pop() || "bin").slice(0, 5);
      const path = `${channel.organization_id}/${safeId}.${ext}`;
      const { error } = await db.storage
        .from("media")
        .upload(path, buf, { contentType: ct, upsert: true });
      if (!error) {
        return { url: db.storage.from("media").getPublicUrl(path).data.publicUrl, transcription: finalTranscription };
      }
      return { url, transcription: finalTranscription };
    }
  } catch {
    /* mantém a URL crua da UAZAPI */
  }
  return { url, transcription };
}
