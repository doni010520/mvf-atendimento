import { NextResponse } from "next/server";
import { parseUazapiWebhook, parseUazapiStatus } from "@/lib/whatsapp/uazapi";
import { persistInbound, persistStatusUpdates } from "@/lib/whatsapp/inbound";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { logEvent } from "@/lib/log";

export async function POST(request: Request) {
  // Verifica token compartilhado ANTES do rate limit: sem isso, um flood SEM
  // token consumia o balde e derrubava o tráfego legítimo do próprio uazapi
  // junto — o token já é a barreira real de segurança.
  const webhookToken = process.env.UAZAPI_WEBHOOK_TOKEN;
  if (webhookToken) {
    const incoming =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      request.headers.get("x-webhook-token") ??
      new URL(request.url).searchParams.get("token");
    if (incoming !== webhookToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Todos os canais uazapi (Nova Canaã, Rio do Meio, Firmino Alves, Iguaí 2...)
  // vivem na MESMA instância/IP — os eventos de TODOS eles (mensagem recebida +
  // cada confirmação enviada→entregue→lida) caem no MESMO balde de rate limit.
  // Em 300/min ele estourava em horário de pico e o excesso era descartado
  // CALADO: status ficava preso em "enviada" por horas, sem log nenhum (a
  // checagem de token vinha DEPOIS, então nem esse rastro sobrava). Achado em
  // 04/09 (Micaely, canal NOVA CANAÃ: 68% das mensagens presas; RIO DO MEIO
  // chegou a 90%). Teto subiu bastante — o token acima já filtra abuso; o
  // limite aqui é só para não deixar um cliente descontrolado nos afogar.
  const rl = rateLimit(`uazapi:${getClientIp(request)}`, 3000, 60_000);
  if (!rl.ok) {
    void logEvent("error", "uazapi", `Webhook rate limit estourado: ${rl.remaining} restantes, retry em ${rl.retryAfterMs}ms — eventos sendo DESCARTADOS.`, {});
    return NextResponse.json({ error: "Too Many Requests" }, {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }

  try {
    const payload = await request.json();
    const messages = parseUazapiWebhook(payload);
    if (messages.length) await persistInbound(messages);
    const updates = parseUazapiStatus(payload);
    if (updates.length) await persistStatusUpdates(updates);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("uazapi webhook error", e);
    return NextResponse.json({ ok: false }, { status: 200 }); // 200 evita reenvio em loop
  }
}
