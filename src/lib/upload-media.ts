"use client";

/**
 * Envio de arquivo FORA de server action (10/08/2026): corpo CRU no body +
 * metadados na query, com timeout de 90s no navegador. O caminho antigo
 * (multipart → "use server") falhava por teto/parser do transporte da action e
 * ficava girando pra sempre quando o servidor engasgava. Ver
 * app/api/atendimento/enviar-midia/route.ts (lado servidor, com conferência de
 * bytes por streaming).
 */
export async function uploadMediaRaw(
  conversationId: string,
  file: File,
  asSticker?: boolean,
): Promise<{ ok?: boolean; error?: string }> {
  const caption = (file as File & { caption?: string }).caption;
  try {
    const qs = new URLSearchParams({ conversationId, filename: file.name || "arquivo" });
    if (caption) qs.set("caption", caption);
    if (asSticker) qs.set("kind", "sticker");
    const resp = await fetch(`/api/atendimento/enviar-midia?${qs.toString()}`, {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
      signal: AbortSignal.timeout(90_000),
    });
    return (await resp.json().catch(() => null)) ?? { ok: false, error: `Falha no envio (HTTP ${resp.status}). Tente novamente.` };
  } catch (e) {
    return (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError"
      ? { ok: false, error: "O envio não respondeu em 90s. Confira se o arquivo apareceu na conversa antes de reenviar." }
      : { ok: false, error: "Falha de conexão no envio do arquivo. Verifique sua internet e tente de novo." };
  }
}
