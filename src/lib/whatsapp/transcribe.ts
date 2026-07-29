/** Transcreve um áudio via OpenAI (Whisper). Best-effort: retorna undefined se falhar. */
export async function transcribeAudio(buffer: Buffer, mimetype: string): Promise<string | undefined> {
  const ext = mimetype.includes("mpeg") ? "mp3"
    : mimetype.includes("mp4") || mimetype.includes("m4a") ? "m4a"
    : mimetype.includes("wav") ? "wav" : "ogg";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimetype }), `audio.${ext}`);
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || undefined;
}
