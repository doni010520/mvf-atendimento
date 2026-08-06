import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getProvider } from "@/lib/whatsapp";
import { logEvent } from "@/lib/log";
import type { Channel } from "@/lib/types";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * Gateway de "SMS" do SGP → WhatsApp (substitui o HTTP Genérico do Chatmix).
 *
 * No SGP (Configurações → SMS Gateway → HTTP Genérico), a config define os
 * NOMES dos parâmetros: set_to="numero" e set_msg="mensagem" — o SGP chama a
 * URL passando numero=<telefone>, mensagem=<texto> e os demais campos da
 * config (token etc.). Este endpoint recebe o disparo e ENTREGA a mensagem
 * pelo WhatsApp, registrando na conversa do contato.
 *
 * Entrega: tenta o canal padrão (MVF CENTRAL, oficial). Se a Meta recusar
 * (ex.: fora da janela de 24h — erro de re-engajamento), cai para o primeiro
 * canal uazapi conectado (sem restrição de janela). Tudo vai para app_logs.
 *
 * Aceita GET e POST (query, form ou JSON) e nomes flexíveis:
 *   telefone: numero | phone | celular | to | telefone
 *   mensagem: mensagem | msg | message | texto | text
 *   auth    : token | key  (== SGP_SMS_TOKEN do ambiente)
 *   canal   : channel | canal (nome; padrão "MVF CENTRAL")
 */

const pick = (src: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
};

/** Normaliza pra formato WhatsApp BR: DDD+numero vira 55DDDnumero. */
function normPhone(raw: string): string | null {
  const d = raw.replace(/\D+/g, "");
  if (!d) return null;
  if (d.startsWith("55") && d.length >= 12) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d.length >= 8 ? d : null;
}

type Db = ReturnType<typeof createServiceClient>;

/** Entrega a mensagem por UM canal: acha/cria contato+conversa e envia. */
async function deliverVia(db: Db, channel: Channel, phone: string, msg: string): Promise<{ ok: boolean; erro?: string }> {
  const org = channel.organization_id as string;
  try {
    // Nono dígito: o mesmo número pode existir com ou sem o "9" (o wa_id do
    // WhatsApp costuma vir SEM). Reaproveita o contato existente em qualquer
    // forma — e envia para o telefone DELE (que comprovadamente entrega) — em
    // vez de criar um contato duplicado.
    const alt = phone.startsWith("55") && phone.length === 13 ? phone.slice(0, 4) + phone.slice(5)
      : phone.startsWith("55") && phone.length === 12 ? phone.slice(0, 4) + "9" + phone.slice(4) : null;
    const { data: found } = await db
      .from("contacts")
      .select("id, phone")
      .eq("organization_id", org)
      .in("phone", alt ? [phone, alt] : [phone])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    let contact = found;
    if (contact?.phone) phone = contact.phone;
    if (!contact) {
      const { data: created } = await db
        .from("contacts")
        .upsert(
          { organization_id: org, phone, is_group: false },
          { onConflict: "organization_id,phone", ignoreDuplicates: false },
        )
        .select("id, phone")
        .single();
      contact = created;
    }
    if (!contact) return { ok: false, erro: "contato não criado" };

    let { data: conv } = await db
      .from("conversations")
      .select("id")
      .eq("channel_id", channel.id)
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!conv) {
      const { data: created } = await db
        .from("conversations")
        .insert({ organization_id: org, channel_id: channel.id, contact_id: contact.id, status: "closed", ai_enabled: true })
        .select("id")
        .single();
      conv = created;
    }
    if (!conv) return { ok: false, erro: "conversa não criada" };

    const provider = getProvider(channel);
    const res = await provider.sendText({ to: phone, text: msg });
    await db.from("messages").insert({
      organization_id: org, conversation_id: conv.id, direction: "out",
      sender_type: "system", content_type: "text", body: msg,
      external_id: res.externalId ?? null, status: "sent",
    });
    await db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conv.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: (e as Error)?.message?.slice(0, 200) ?? "erro" };
  }
}

async function handle(request: Request): Promise<NextResponse> {
  const rl = rateLimit(`sgpsms:${getClientIp(request)}`, 240, 60_000);
  if (!rl.ok) return NextResponse.json({ status: 0, erro: "rate limit" }, { status: 429 });

  // Junta parâmetros de query + corpo (form ou JSON) — o SGP pode usar qualquer um.
  const url = new URL(request.url);
  const params: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
  if (request.method === "POST") {
    const ct = request.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/json")) Object.assign(params, await request.json());
      else Object.assign(params, Object.fromEntries((await request.formData()).entries()));
    } catch { /* corpo vazio/ilegível: segue só com a query */ }
  }

  const secret = process.env.SGP_SMS_TOKEN;
  const given = pick(params, ["token", "key", "apikey"]);
  if (!secret || given !== secret) {
    return NextResponse.json({ status: 0, erro: "token inválido" }, { status: 401 });
  }

  const phonesRaw = pick(params, ["numero", "phone", "celular", "to", "telefone"]);
  const msg = pick(params, ["mensagem", "msg", "message", "texto", "text"]);
  if (!phonesRaw || !msg) return NextResponse.json({ status: 0, erro: "informe numero e mensagem" }, { status: 400 });
  const phones = phonesRaw.split(",").map(normPhone).filter((p): p is string => !!p);
  if (!phones.length) return NextResponse.json({ status: 0, erro: "telefone inválido" }, { status: 400 });

  const db = createServiceClient();
  // Linha padrão de saída: configurável por env (pedido da operação: usar a
  // linha NÃO-oficial por enquanto; trocar de volta = mudar SGP_SMS_CHANNEL).
  const channelName = pick(params, ["channel", "canal"]) ?? process.env.SGP_SMS_CHANNEL ?? "MVF CENTRAL";
  const { data: primary } = await db
    .from("channels").select("*").ilike("name", channelName).eq("status", "connected").limit(1).maybeSingle();
  if (!primary) return NextResponse.json({ status: 0, erro: `canal "${channelName}" não encontrado/conectado` }, { status: 404 });
  // Fallbacks: canais uazapi conectados (sem janela de 24h) — usados quando a
  // Meta recusa (cliente fora da janela, comum em aviso de cobrança).
  const { data: uazapis } = await db
    .from("channels").select("*").eq("type", "uazapi").eq("status", "connected").eq("organization_id", primary.organization_id);
  const chain: Channel[] = [primary as Channel, ...(((uazapis ?? []) as Channel[]).filter((c) => c.id !== primary.id))];

  const results: { phone: string; ok: boolean; via?: string; erro?: string }[] = [];
  for (const phone of phones) {
    let done: { ok: boolean; via?: string; erro?: string } = { ok: false };
    for (const ch of chain) {
      const r = await deliverVia(db, ch, phone, msg);
      if (r.ok) { done = { ok: true, via: ch.name as string }; break; }
      done = { ok: false, erro: r.erro };
    }
    results.push({ phone, ...done });
  }

  const okCount = results.filter((r) => r.ok).length;
  void logEvent(
    okCount ? "info" : "error",
    "sgp-sms",
    `SGP→WhatsApp: ${okCount}/${results.length} entregue(s) — "${msg.slice(0, 70)}"`,
    { results },
    primary.organization_id,
  );
  return NextResponse.json({ status: okCount ? 1 : 0, ok: okCount > 0, results });
}

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
