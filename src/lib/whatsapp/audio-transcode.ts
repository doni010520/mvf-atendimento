import { spawn } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Converte um áudio (ex.: o webm/opus que o navegador grava) para OGG/OPUS.
 *
 * Motivo: a Cloud API da Meta NÃO aceita webm — só aac, amr, mp3, m4a e
 * ogg(opus). Sem converter, todo áudio gravado no Chrome falhava nos números
 * oficiais. OGG/OPUS mono também renderiza como nota de voz no WhatsApp.
 *
 * Best-effort: retorna null se o ffmpeg falhar (aí segue com o original).
 * Requer o binário `ffmpeg` no PATH (instalado na imagem via apk).
 */
/**
 * Converte para MP3 (mono, 64k). Motivo: descoberto em produção (03/08/2026)
 * que o WhatsApp no iPhone recusava nossos ogg/opus com "este áudio não está
 * mais disponível" MESMO com o arquivo íntegro e a Meta reportando delivered —
 * enquanto o MESMO áudio em MP3 toca normalmente. MP3 é o formato mais
 * universalmente aceito pelos aparelhos; usamos ele nos canais Meta.
 */
export async function toMp3(input: Buffer): Promise<Buffer | null> {
  const id = crypto.randomUUID();
  const inPath = path.join(tmpdir(), `mvf-m-${id}.in`);
  const outPath = path.join(tmpdir(), `mvf-m-${id}.mp3`);
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(
        "ffmpeg",
        ["-y", "-i", inPath, "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "44100", "-ac", "1", "-f", "mp3", outPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      ff.stderr.on("data", (d) => { err += d.toString(); });
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
    });
    return await readFile(outPath);
  } catch (e) {
    console.error("toMp3", (e as Error)?.message);
    return null;
  } finally {
    unlink(inPath).catch(() => {});
    unlink(outPath).catch(() => {});
  }
}

export async function toOggOpus(input: Buffer): Promise<Buffer | null> {
  const id = crypto.randomUUID();
  const inPath = path.join(tmpdir(), `mvf-a-${id}.in`);
  const outPath = path.join(tmpdir(), `mvf-a-${id}.ogg`);
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(
        "ffmpeg",
        [
          "-y", "-i", inPath,
          "-c:a", "libopus", "-b:a", "32k",
          // vbr off = taxa constante: mesmo trecho silencioso gera um stream
          // "cheio". Sem isso, gravação sem som virava um arquivo degenerado de
          // ~1KB que o WhatsApp recusava com "áudio não está mais disponível".
          "-vbr", "off", "-application", "voip",
          "-ar", "48000", "-ac", "1", "-f", "ogg", outPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      ff.stderr.on("data", (d) => { err += d.toString(); });
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
    });
    return await readFile(outPath);
  } catch (e) {
    console.error("toOggOpus", (e as Error)?.message);
    return null;
  } finally {
    unlink(inPath).catch(() => {});
    unlink(outPath).catch(() => {});
  }
}
