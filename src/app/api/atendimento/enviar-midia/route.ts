import { NextResponse } from "next/server";
import { sendMediaMessage } from "@/app/(app)/atendimento/actions";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Envio de arquivo FORA de server action (10/08/2026). O caminho antigo
 * (multipart → "use server") falhava de 4 jeitos empilhados: teto do transporte
 * da action, parser de FormData quebrando ("Failed to parse body as FormData"),
 * corpo chegando CORTADO em rede ruim (arrayBuffer resolvia pela metade) e
 * fetch sem timeout no navegador (tela girando pra sempre). Aqui: corpo CRU no
 * body (só bytes, sem multipart), metadados na query string, leitura por
 * STREAMING conferindo os bytes recebidos contra o Content-Length, e a lógica
 * de envio reaproveitada por chamada direta (servidor→servidor, sem HTTP da
 * action no meio).
 */
export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const caption = url.searchParams.get("caption") ?? "";
    const kind = url.searchParams.get("kind") ?? "";
    const filename = url.searchParams.get("filename") || "arquivo.bin";
    const contentType = request.headers.get("content-type") || "application/octet-stream";
    if (!conversationId) return NextResponse.json({ ok: false, error: "Conversa não informada." }, { status: 400 });

    const declared = Number(request.headers.get("content-length") || 0);
    const reader = request.body?.getReader();
    if (!reader) return NextResponse.json({ ok: false, error: "Arquivo não recebido." }, { status: 400 });
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(Buffer.from(value)); received += value.length; }
      if (received > 48 * 1024 * 1024) {
        return NextResponse.json({ ok: false, error: "Arquivo muito grande. O máximo é 48MB — comprima ou envie em partes." }, { status: 413 });
      }
    }
    if (!received) return NextResponse.json({ ok: false, error: "Arquivo vazio." }, { status: 400 });
    if (declared > 0 && received !== declared) {
      return NextResponse.json(
        { ok: false, error: `O arquivo chegou incompleto (${received} de ${declared} bytes) — conexão instável. Tente novamente.` },
        { status: 400 },
      );
    }

    const file = new File([Buffer.concat(chunks)], filename, { type: contentType });
    const fd = new FormData();
    fd.set("conversationId", conversationId);
    if (caption) fd.set("caption", caption);
    if (kind) fd.set("kind", kind);
    fd.set("file", file);
    const res = await sendMediaMessage(fd);
    return NextResponse.json(res ?? { ok: false });
  } catch (e) {
    console.error("[enviar-midia]", e);
    return NextResponse.json({ ok: false, error: "Falha no envio do arquivo. Tente novamente." }, { status: 500 });
  }
}
