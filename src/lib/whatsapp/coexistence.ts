import { createServiceClient } from "@/lib/supabase/server";
import type { OutboundEcho, ContactStateSync } from "./meta";
import { canonicalPhone } from "@/lib/utils";

/** Localiza o canal pelo phone_number_id (external_id). */
async function findChannel(db: ReturnType<typeof createServiceClient>, externalId: string) {
  const { data } = await db
    .from("channels")
    .select("id, organization_id")
    .eq("external_id", externalId)
    .maybeSingle();
  return data;
}

async function upsertContact(
  db: ReturnType<typeof createServiceClient>,
  org: string,
  phone: string,
  name?: string,
) {
  const { data } = await db
    .from("contacts")
    .upsert(
      { organization_id: org, phone: canonicalPhone(phone), name: name ?? null },
      { onConflict: "organization_id,phone", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  return data?.id as string | undefined;
}

/**
 * Persiste ecos de mensagens enviadas pelo atendente no app WhatsApp Business.
 * Gravadas como mensagens de SAÍDA (sender_type "agent") para manter a inbox em sincronia.
 */
export async function persistEchoes(echoes: OutboundEcho[]) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const db = createServiceClient();

  for (const e of echoes) {
    if (!e.channelExternalId || !e.to) continue;
    const channel = await findChannel(db, e.channelExternalId);
    if (!channel) continue;
    const org = channel.organization_id;
    const contactId = await upsertContact(db, org, e.to);
    if (!contactId) continue;

    // Conversa em aberto (reaproveita ou cria)
    const { data: existing } = await db
      .from("conversations")
      .select("id")
      .eq("channel_id", channel.id)
      .eq("contact_id", contactId)
      .in("status", ["bot", "queued", "open"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let conversationId = existing?.id as string | undefined;
    if (!conversationId) {
      const { data: conv } = await db
        .from("conversations")
        .insert({
          organization_id: org,
          channel_id: channel.id,
          contact_id: contactId,
          status: "open",
          last_message_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      conversationId = conv?.id;
    }

    await db.from("messages").insert({
      organization_id: org,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "agent",
      content_type: e.contentType,
      body: e.body ?? null,
      external_id: e.externalId ?? null,
      status: "sent",
    });

    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", conversationId);
  }
}

/** Sincroniza o catálogo de contatos vindo do app WhatsApp Business. */
export async function persistContactSync(items: ContactStateSync[]) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const db = createServiceClient();

  for (const c of items) {
    if (!c.channelExternalId || !c.phone) continue;
    const channel = await findChannel(db, c.channelExternalId);
    if (!channel) continue;
    const org = channel.organization_id;

    if (c.action === "remove") {
      // Mantemos o contato (histórico), apenas não atualizamos. Política pode mudar.
      continue;
    }
    await upsertContact(db, org, c.phone, c.name);
  }
}
