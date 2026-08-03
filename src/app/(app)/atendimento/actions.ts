"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth";
import { getProvider } from "@/lib/whatsapp";
import { toOggOpus } from "@/lib/whatsapp/audio-transcode";
import { getMessages, getConversations } from "@/lib/data/conversations";
import { logEvent } from "@/lib/log";
import type { Channel, ContentType, InternalMention } from "@/lib/types";

const isPreview = () => !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function fetchMessages(conversationId: string) {
  return getMessages(conversationId);
}

/** Lista atualizada de conversas (usada pelo polling da inbox). */
export async function fetchConversations() {
  return getConversations();
}

/** Retorna status dos canais (para mostrar banner de desconectado). */
export async function fetchChannelStatuses(): Promise<{ id: string; name: string; status: string }[]> {
  if (isPreview()) return [];
  const supabase = await createClient();
  const { data } = await supabase.from("channels").select("id, name, status");
  return (data as { id: string; name: string; status: string }[]) ?? [];
}

/**
 * Abre (ou cria) uma conversa 1:1 com um participante — ex.: clicar no nome num grupo.
 * Se só houver o LID (mensagem comum de grupo), resolve o telefone via /group/info.
 */
export async function openDirectConversation(
  channelId: string,
  opts: { phone?: string; lid?: string; name?: string; groupJid?: string },
) {
  if (isPreview()) return { id: null as string | null };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();

  let digits = (opts.phone || "").replace(/\D/g, "");
  // Resolve LID → telefone real consultando os participantes do grupo.
  if (!digits && opts.lid && opts.groupJid) {
    const { data: channel } = await supabase.from("channels").select("*").eq("id", channelId).single();
    const parts = await getProvider(channel as Channel)
      .getGroupParticipants?.(opts.groupJid)
      .catch(() => [] as { lid: string; phone: string }[]);
    const lidDigits = opts.lid.replace(/\D/g, "");
    digits = (parts ?? []).find((p) => p.lid === lidDigits)?.phone ?? "";
  }
  if (!digits) return { id: null };
  const name = opts.name;

  const { data: contact } = await supabase
    .from("contacts")
    .upsert(
      { organization_id: session.organization.id, phone: digits, name: name ?? null, is_group: false },
      { onConflict: "organization_id,phone", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (!contact) return { id: null };

  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("channel_id", channelId)
    .eq("contact_id", contact.id)
    .in("status", ["bot", "queued", "open"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let id = existing?.id ?? null;
  if (!id) {
    const { data: conv } = await supabase
      .from("conversations")
      .insert({
        organization_id: session.organization.id,
        channel_id: channelId,
        contact_id: contact.id,
        status: "open",
        last_message_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    id = conv?.id ?? null;
  }
  revalidatePath("/atendimento");
  return { id };
}

/**
 * Resolve o telefone/nome de um participante SEM criar contato/conversa.
 * Usado ao clicar num participante de grupo — só materializa ao digitar/enviar.
 */
export async function resolveDirectContact(
  channelId: string,
  opts: { phone?: string; lid?: string; name?: string; groupJid?: string },
): Promise<{ phone: string | null; name: string | null; existingId: string | null }> {
  if (isPreview()) return { phone: null, name: null, existingId: null };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();

  let digits = (opts.phone || "").replace(/\D/g, "");
  if (!digits && opts.lid && opts.groupJid) {
    const { data: channel } = await supabase.from("channels").select("*").eq("id", channelId).single();
    const parts = await getProvider(channel as Channel)
      .getGroupParticipants?.(opts.groupJid)
      .catch(() => [] as { lid: string; phone: string }[]);
    const lidDigits = opts.lid.replace(/\D/g, "");
    digits = (parts ?? []).find((p) => p.lid === lidDigits)?.phone ?? "";
  }
  if (!digits) return { phone: null, name: null, existingId: null };

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, name")
    .eq("organization_id", session.organization.id)
    .eq("phone", digits)
    .maybeSingle();

  let existingId: string | null = null;
  if (contact) {
    const { data: ex } = await supabase
      .from("conversations")
      .select("id")
      .eq("channel_id", channelId)
      .eq("contact_id", contact.id)
      .in("status", ["bot", "queued", "open"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    existingId = ex?.id ?? null;
  }
  return { phone: digits, name: opts.name ?? contact?.name ?? null, existingId };
}

export interface ContactDetails {
  id: string;
  name: string | null;
  phone: string;
  avatar_url: string | null;
  is_group: boolean;
  notes: string | null;
  custom_fields: Record<string, unknown>;
}

/** Detalhes do contato da conversa (para o painel lateral / CRM). */
export async function getContactDetails(conversationId: string): Promise<ContactDetails | null> {
  if (isPreview()) return null;
  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("contact_id")
    .eq("id", conversationId)
    .single();
  if (!conv) return null;
  const { data: c } = await supabase
    .from("contacts")
    .select("id, name, phone, avatar_url, is_group, notes, custom_fields")
    .eq("id", conv.contact_id)
    .single();
  return (c as ContactDetails) ?? null;
}

/** Histórico de atendimentos do contato desta conversa. */
export async function getContactHistory(conversationId: string) {
  if (isPreview()) return [];
  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("contact_id")
    .eq("id", conversationId)
    .single();
  if (!conv) return [];
  const { data } = await supabase
    .from("conversations")
    .select("id, protocol, status, opened_at, closed_at, close_reason")
    .eq("contact_id", conv.contact_id)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = (data ?? []) as { id: string; protocol: string | null; status: string; opened_at: string | null; closed_at: string | null; close_reason: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    protocol: r.protocol,
    status: r.status,
    opened_at: r.opened_at,
    closed_at: r.closed_at,
    summary: parseCloseSummary(r.close_reason),
  }));
}

/** Resumo estruturado do encerramento (parse do close_reason, com fallback para
 *  reasons antigos em texto puro). Não exportado (arquivo "use server"). */
function parseCloseSummary(raw: string | null): { motivo: string; solucao: string; encaminhamentos: string; pendencias: string } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, string>;
    if (o && typeof o === "object" && ("motivo" in o || "solucao" in o || "encaminhamentos" in o || "pendencias" in o)) {
      return { motivo: o.motivo ?? "", solucao: o.solucao ?? "", encaminhamentos: o.encaminhamentos ?? "", pendencias: o.pendencias ?? "" };
    }
  } catch { /* não é JSON: reason antigo em texto puro */ }
  return { motivo: raw, solucao: "", encaminhamentos: "", pendencias: "" };
}

/** Salva nome, observações e campos personalizados (CRM) do contato. */
export async function updateContactDetails(
  conversationId: string,
  patch: { name?: string; notes?: string; custom_fields?: Record<string, unknown> },
) {
  if (isPreview()) return { ok: true };
  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("contact_id")
    .eq("id", conversationId)
    .single();
  if (!conv) return { ok: false };
  const upd: Record<string, unknown> = {};
  if (patch.name !== undefined) upd.name = patch.name.trim() || null;
  if (patch.notes !== undefined) upd.notes = patch.notes;
  if (patch.custom_fields !== undefined) upd.custom_fields = patch.custom_fields;
  await supabase.from("contacts").update(upd).eq("id", conv.contact_id);
  revalidatePath("/atendimento");
  return { ok: true };
}

export interface GroupInfoResult {
  name?: string;
  description?: string;
  participants: { phone: string; name: string | null; isAdmin: boolean; isOwner: boolean }[];
}

/** Informações do grupo da conversa (nome, descrição, participantes com nomes resolvidos). */
export async function getGroupInfo(conversationId: string): Promise<GroupInfoResult | null> {
  if (isPreview()) return null;
  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("channel_id, is_group, contact_jid, contact_phone")
    .eq("id", conversationId)
    .single();
  if (!conv?.is_group) return null;
  const { data: channel } = await supabase.from("channels").select("*").eq("id", conv.channel_id).single();
  const jid = (conv.contact_jid as string) || `${conv.contact_phone}@g.us`;
  const info = await getProvider(channel as Channel).getGroupInfo?.(jid);
  if (!info) return null;

  // Resolve nomes a partir dos nossos contatos.
  const phones = info.participants.map((p) => p.phone).filter(Boolean);
  const names = new Map<string, string>();
  if (phones.length) {
    const { data: contacts } = await supabase.from("contacts").select("phone, name").in("phone", phones);
    for (const c of contacts ?? []) if (c.name) names.set(c.phone, c.name);
  }
  return {
    name: info.name,
    description: info.description,
    participants: info.participants
      .filter((p) => p.phone)
      .map((p) => ({
        phone: p.phone,
        name: names.get(p.phone) ?? null,
        isAdmin: p.isAdmin,
        isOwner: p.phone === info.owner,
      }))
      .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || Number(b.isAdmin) - Number(a.isAdmin)),
  };
}

export async function sendMessage(
  conversationId: string,
  text: string,
  replyToExternal?: string,
  mentions?: { name: string; phone: string }[],
  autoClaim = true,
): Promise<{ ok: boolean; error?: string }> {
  let body = text.trim();
  if (!body) return { ok: false };
  if (isPreview()) return { ok: true }; // modo preview: client mantém otimista

  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();

  // Identificar atendente: prefixa o nome se configurado.
  const orgSettings = (session.organization.settings ?? {}) as Record<string, unknown>;
  if (orgSettings.identify_agent && session.profile?.name) {
    body = `*${session.profile.name}:*\n${body}`;
  }

  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("contact_phone, channel_id, status, is_group, contact_jid, assigned_user_id")
    .eq("id", conversationId)
    .single();
  if (!conv) throw new Error("Conversa não encontrada.");

  // Trecho da mensagem citada (para exibir o quote no nosso lado).
  let replyExcerpt: string | null = null;
  if (replyToExternal) {
    const { data: q } = await supabase
      .from("messages")
      .select("body, content_type")
      .eq("external_id", replyToExternal)
      .maybeSingle();
    replyExcerpt = q?.body ?? (q?.content_type && q.content_type !== "text" ? `[${q.content_type}]` : null);
  }

  const { data: msg } = await supabase
    .from("messages")
    .insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "agent",
      sender_id: session.userId,
      content_type: "text",
      body,
      reply_to_external: replyToExternal ?? null,
      reply_excerpt: replyExcerpt,
      status: "pending",
    })
    .select("id")
    .single();

  // Marca atividade IMEDIATAMENTE (antes do round-trip do provedor, que leva
  // segundos) para o cron de inatividade não encerrar a conversa que o atendente
  // acabou de reativar. Também limpa o aviso pendente ("Você ainda está por aí?").
  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString(), inactivity_warned_at: null })
    .eq("id", conversationId);

  // Envia pelo provedor do canal.
  let deliveryError: string | null = null;
  try {
    const { data: channel } = await supabase
      .from("channels")
      .select("*")
      .eq("id", conv.channel_id)
      .single();
    const to = recipientOf(conv);
    // Menções: no texto enviado, "@Nome" vira "@<número>" (o que o WhatsApp linka).
    let waText = body;
    const mentionNums: string[] = [];
    for (const m of mentions ?? []) {
      const digits = m.phone.replace(/\D/g, "");
      if (!digits) continue;
      mentionNums.push(digits);
      waText = waText.split(`@${m.name}`).join(`@${digits}`);
    }
    const res = await getProvider(channel as Channel).sendText({
      to,
      text: waText,
      replyId: replyToExternal,
      mentions: mentionNums.length ? mentionNums : undefined,
    });
    await supabase
      .from("messages")
      .update({ status: "sent", external_id: res.externalId ?? null })
      .eq("id", msg!.id);
  } catch (e) {
    console.error("send error", e);
    void logEvent("error", "send", `Falha ao enviar mensagem: ${(e as Error)?.message ?? e}`, { conversationId });
    const raw = (e as Error)?.message ?? "";
    // Janela de 24h da Meta (erro 131047/131026) → mensagem amigável.
    deliveryError = /131047|131026|re-?engag|24 ?h|outside|template/i.test(raw)
      ? "Fora da janela de 24h: neste canal oficial, só é possível enviar um modelo (template) aprovado."
      : "Não foi possível entregar a mensagem.";
    await supabase.from("messages").update({ status: "failed" }).eq("id", msg!.id);
  }

  // Se o atendente respondeu numa conversa que estava na IA, a IA para
  // automaticamente (equivalente ao "atendente assumiu ao interagir").
  const wasBot = conv.status === "bot";
  // Quem responde ASSUME a conversa se ela ainda não tem dono. Sem isso, uma
  // conversa aberta/na fila (ex.: passou pela IA ou por transferência) em que o
  // atendente responde continuava SEM atribuição — e ficava visível para todos
  // os outros atendentes. Agora, ao responder, vira dele (some da lista alheia).
  const claim = autoClaim && !conv.assigned_user_id;
  await supabase
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      inactivity_warned_at: null,
      status: conv.status === "closed" ? "open" : wasBot ? "open" : conv.status,
      ...(wasBot ? { ai_enabled: false } : {}),
      ...(claim ? { assigned_user_id: session.userId, offered_to: null } : {}),
    })
    .eq("id", conversationId);
  if (wasBot) {
    await supabase.from("messages").insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "system",
      content_type: "text",
      body: `IA pausada — ${session.profile?.name ?? "atendente"} assumiu ao responder.`,
      is_internal: true,
      status: "sent",
    });
    void logEvent("info", "atendente", `${session.profile?.name ?? "Atendente"} assumiu ao responder (IA pausada)`, { conversationId, userId: session.userId, action: "assumir_ao_responder" }, session.organization.id);
  }

  revalidatePath("/atendimento");
  return { ok: !deliveryError, error: deliveryError ?? undefined };
}

/** Adiciona uma nota interna na conversa (visível só para a equipe, não vai ao cliente). */
export async function addInternalNote(conversationId: string, text: string) {
  if (isPreview()) return { ok: true };
  const note = text.trim();
  if (!note) return { ok: false };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();
  await supabase.from("messages").insert({
    organization_id: session.organization.id,
    conversation_id: conversationId,
    direction: "out",
    sender_type: "system",
    sender_id: session.userId,
    content_type: "text",
    body: session.profile?.name ? `${session.profile.name}: ${note}` : note,
    is_internal: true,
    status: "sent",
  });
  revalidatePath("/atendimento");
  return { ok: true };
}

/** Lista os atendentes da organização (para o autocomplete de @menção interna). */
export async function getOrgAgents(): Promise<{ id: string; name: string; avatar_url: string | null }[]> {
  if (isPreview()) return [];
  const session = await getSession();
  if (!session?.organization) return [];
  const db = createServiceClient();
  const { data } = await db
    .from("profiles")
    .select("id, name, avatar_url")
    .eq("organization_id", session.organization.id)
    .order("name");
  return ((data ?? []) as { id: string; name: string | null; avatar_url: string | null }[]).map((p) => ({
    id: p.id,
    name: p.name ?? "Atendente",
    avatar_url: p.avatar_url ?? null,
  }));
}

/**
 * Envia uma mensagem INTERNA (entre atendentes) numa conversa. O cliente nunca
 * recebe. Suporta @menção de atendentes, que geram notificação (sino).
 */
export async function sendInternalMessage(
  conversationId: string,
  text: string,
  mentions?: { id: string; name: string }[],
) {
  if (isPreview()) return { ok: true };
  const body = text.trim();
  if (!body) return { ok: false };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const db = createServiceClient();
  const authorName = session.profile?.name ?? "Atendente";
  // Só conta menções que realmente aparecem no texto final.
  const used = (mentions ?? []).filter((m) => body.includes(`@${m.name}`));

  const { data: msg } = await db
    .from("messages")
    .insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "agent",
      sender_id: session.userId,
      content_type: "text",
      body,
      author_name: authorName,
      is_internal: true,
      mentions: used,
      status: "sent",
    })
    .select("id")
    .single();

  // Notifica os atendentes mencionados (menos o próprio autor).
  const targets = used.filter((m) => m.id && m.id !== session.userId);
  if (msg && targets.length) {
    const { data: conv } = await db
      .from("conversation_overview")
      .select("contact_name")
      .eq("id", conversationId)
      .maybeSingle();
    await db.from("internal_mentions").insert(
      targets.map((t) => ({
        organization_id: session.organization!.id,
        conversation_id: conversationId,
        message_id: msg.id,
        mentioned_user_id: t.id,
        created_by: session.userId,
        author_name: authorName,
        excerpt: body.slice(0, 140),
        contact_name: (conv?.contact_name as string) ?? null,
      })),
    );
  }

  await db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);
  revalidatePath("/atendimento");
  return { ok: true };
}

/** Menções internas não lidas do atendente logado (para o sino/badge). */
export async function getUnreadMentions(): Promise<InternalMention[]> {
  if (isPreview()) return [];
  const session = await getSession();
  if (!session?.userId) return [];
  const db = createServiceClient();
  const { data } = await db
    .from("internal_mentions")
    .select("*")
    .eq("mentioned_user_id", session.userId)
    .is("read_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data as InternalMention[]) ?? [];
}

/** Marca menções como lidas (de uma conversa, ou todas se omitido). */
export async function markMentionsRead(conversationId?: string) {
  if (isPreview()) return { ok: true };
  const session = await getSession();
  if (!session?.userId) return { ok: false };
  const db = createServiceClient();
  let q = db
    .from("internal_mentions")
    .update({ read_at: new Date().toISOString() })
    .eq("mentioned_user_id", session.userId)
    .is("read_at", null);
  if (conversationId) q = q.eq("conversation_id", conversationId);
  await q;
  return { ok: true };
}

/** Modelos (templates) aprovados disponíveis para envio (Meta, fora da janela). */
export async function getApprovedTemplates(): Promise<
  { name: string; language: string; bodyText: string; varCount: number; channelId: string | null }[]
> {
  if (isPreview()) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("wa_templates")
    .select("name, language, category, components, status, channel_id")
    .order("name");
  type Row = { name: string; language: string; status?: string; components?: unknown; channel_id?: string | null };
  return ((data as Row[]) ?? [])
    .filter((t) => !t.status || /approved|ativo/i.test(t.status))
    .map((t) => {
      const comps = Array.isArray(t.components) ? (t.components as Record<string, unknown>[]) : [];
      const body = comps.find((c) => String(c.type).toUpperCase() === "BODY");
      const bodyText = body ? String(body.text ?? "") : "";
      const varCount = (bodyText.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;
      return { name: t.name, language: t.language || "pt_BR", bodyText, varCount, channelId: t.channel_id ?? null };
    });
}

/** Envia uma mensagem de MODELO (template) — permitido fora da janela de 24h (Meta). */
export async function sendTemplateMessage(
  conversationId: string,
  name: string,
  language: string,
  params: string[] = [],
): Promise<{ ok: boolean; error?: string }> {
  if (isPreview()) return { ok: true };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();

  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("contact_phone, channel_id, is_group, contact_jid, status")
    .eq("id", conversationId)
    .single();
  if (!conv) throw new Error("Conversa não encontrada.");
  const { data: channel } = await supabase.from("channels").select("*").eq("id", conv.channel_id).single();
  const provider = getProvider(channel as Channel);
  if (!provider.sendTemplate) return { ok: false, error: "Este canal não suporta modelos." };

  const components = params.length
    ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }]
    : undefined;

  // Renderiza o CONTEÚDO real do template (corpo com {{n}} substituídos) para
  // mostrar na bolha — em vez de um código tipo "[modelo: x]".
  const { data: tpl } = await supabase
    .from("wa_templates")
    .select("components")
    .eq("name", name)
    .eq("language", language)
    .maybeSingle();
  let rendered = "";
  const comps = Array.isArray(tpl?.components) ? (tpl!.components as Record<string, unknown>[]) : [];
  const bodyComp = comps.find((c) => String(c.type).toUpperCase() === "BODY");
  if (bodyComp?.text) {
    rendered = String(bodyComp.text).replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] ?? `{{${n}}}`);
  }
  const body = rendered || `Modelo enviado: ${name}`;

  const { data: msg } = await supabase
    .from("messages")
    .insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "agent",
      sender_id: session.userId,
      content_type: "template",
      body,
      status: "pending",
    })
    .select("id")
    .single();

  try {
    const res = await provider.sendTemplate({ to: recipientOf(conv), name, language, components });
    await supabase.from("messages").update({ status: "sent", external_id: res.externalId ?? null }).eq("id", msg!.id);
  } catch (e) {
    const raw = (e as Error)?.message ?? "";
    console.error("sendTemplate", raw);
    await supabase.from("messages").update({ status: "failed" }).eq("id", msg!.id);
    // Extrai a mensagem de erro legível da Meta (JSON em error.message).
    let friendly = "Falha ao enviar o modelo.";
    const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
    if (m) friendly = m[1];
    if (/131030|not in allowed list|allowed recipient/i.test(raw))
      friendly = "Conta de teste da Meta: este número não está na lista de destinatários permitidos. Adicione-o em WhatsApp → Configuração da API.";
    else if (/132000|132001|template name|does not exist|not found/i.test(raw))
      friendly = "Modelo não encontrado/aprovado para este número. Verifique o idioma e o status na Meta.";
    else if (/132012|param/i.test(raw))
      friendly = "Parâmetros do modelo incorretos (variáveis faltando ou a mais).";
    return { ok: false, error: friendly };
  }
  // Enviar um template é a reabertura deliberada do contato (fora da janela de 24h):
  // a conversa PRECISA voltar a ficar aberta, senão a resposta do cliente não casa
  // com nenhuma conversa em aberto e o inbound cria uma conversa nova (duplicada).
  await supabase
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      status: "open",
      inactivity_warned_at: null,
      assigned_user_id: session.userId,
    })
    .eq("id", conversationId);
  revalidatePath("/atendimento");
  return { ok: true };
}

export async function assignToMe(conversationId: string) {
  if (isPreview()) return;
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();
  // Assumir = humano no comando → a IA para nesta conversa (não reengaja).
  await supabase
    .from("conversations")
    .update({ assigned_user_id: session.userId, status: "open", ai_enabled: false, offered_to: null })
    .eq("id", conversationId);
  void logEvent("info", "atendente", `${session.profile?.name ?? "Atendente"} assumiu o atendimento (IA pausada)`, { conversationId, userId: session.userId, action: "assumir" }, session.organization.id);

  // Mensagem de atribuição (se configurado). Variáveis suportadas no texto:
  // @atendente_nome (nome de quem assumiu) e @protocolo (nº do atendimento).
  const orgSettings = (session.organization.settings ?? {}) as Record<string, unknown>;
  if (orgSettings.auto_send_assign_msg && session.profile?.name) {
    const { data: autoMsg } = await supabase.from("auto_messages")
      .select("body").eq("organization_id", session.organization.id)
      .eq("event", "agent_assign").eq("active", true).limit(1).maybeSingle();
    if (autoMsg?.body) {
      const { data: conv } = await supabase.from("conversations").select("protocol").eq("id", conversationId).maybeSingle();
      const text = autoMsg.body
        .replace(/@atendente_nome/g, session.profile.name)
        .replace(/@protocolo/g, conv?.protocol ?? "");
      await sendMessage(conversationId, text);
    }
  }

  revalidatePath("/atendimento");
}

export interface CloseOptions {
  reason?: string; // Motivo do atendimento
  solution?: string; // Solução apresentada
  forwardings?: string; // Encaminhamentos realizados
  pending?: string; // Pendências (se houver)
  tagIds?: string[];
  sendSurvey?: boolean;
}

const DEFAULT_SURVEY =
  "Sua opinião é muito importante! De 1 a 5, como você avalia o nosso atendimento? (responda apenas com o número)";

/** Envia a pesquisa de satisfação (CSAT) ao cliente e marca a conversa como aguardando nota. */
async function sendSatisfactionSurvey(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  conversationId: string,
) {
  const { data: org } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  const csat = (org?.settings as { csat?: { message?: string } } | null)?.csat;
  const text = csat?.message?.trim() || DEFAULT_SURVEY;
  try {
    const { to, channel } = await recipientFor(supabase, conversationId);
    const res = await getProvider(channel).sendText({ to, text });
    await supabase.from("messages").insert({
      organization_id: orgId,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "system",
      content_type: "text",
      body: text,
      status: "sent",
      external_id: res.externalId ?? null,
    });
    await supabase.from("conversations").update({ awaiting_satisfaction: true }).eq("id", conversationId);
  } catch (e) {
    console.error("survey", e);
  }
}

/** Encerra o atendimento: classificação (tags) + motivo + pesquisa opcional. */
export async function closeConversation(conversationId: string, opts: CloseOptions = {}) {
  if (isPreview()) return { ok: true };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();

  // Classificação do atendimento (substitui as tags atuais).
  if (opts.tagIds) {
    await supabase.from("conversation_tags").delete().eq("conversation_id", conversationId);
    if (opts.tagIds.length) {
      await supabase
        .from("conversation_tags")
        .insert(opts.tagIds.map((tag_id) => ({ conversation_id: conversationId, tag_id })));
    }
  }

  // Resumo estruturado do atendimento (continuidade): motivo, solução,
  // encaminhamentos e pendências — guardado como JSON no close_reason.
  const summary = {
    motivo: opts.reason?.trim() || "",
    solucao: opts.solution?.trim() || "",
    encaminhamentos: opts.forwardings?.trim() || "",
    pendencias: opts.pending?.trim() || "",
  };
  const hasSummary = Object.values(summary).some(Boolean);

  await supabase
    .from("conversations")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      close_reason: hasSummary ? JSON.stringify(summary) : null,
    })
    .eq("id", conversationId);

  // Registro interno do encerramento (histórico, não vai ao cliente).
  if (hasSummary) {
    const lines = [
      summary.motivo && `*Motivo:* ${summary.motivo}`,
      summary.solucao && `*Solução:* ${summary.solucao}`,
      summary.encaminhamentos && `*Encaminhamentos:* ${summary.encaminhamentos}`,
      summary.pendencias && `*Pendências:* ${summary.pendencias}`,
    ].filter(Boolean).join("\n");
    await supabase.from("messages").insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "system",
      sender_id: session.userId,
      content_type: "text",
      body: `📋 Atendimento encerrado\n${lines}`,
      is_internal: true,
      status: "sent",
    });
  }

  if (opts.sendSurvey) {
    await sendSatisfactionSurvey(supabase, session.organization.id, conversationId);
  }

  void logEvent("info", "atendente", `${session.profile?.name ?? "Atendente"} encerrou o atendimento`, { conversationId, userId: session.userId, action: "encerrar" }, session.organization.id);
  revalidatePath("/atendimento");
  return { ok: true };
}

function kindFromMime(mime: string): { kind: "image" | "audio" | "video" | "document"; content: ContentType } {
  if (mime.startsWith("image")) return { kind: "image", content: "image" };
  if (mime.startsWith("audio")) return { kind: "audio", content: "audio" };
  if (mime.startsWith("video")) return { kind: "video", content: "video" };
  return { kind: "document", content: "document" };
}

/** Envia um arquivo (imagem/áudio/vídeo/documento) numa conversa. */
export async function sendMediaMessage(formData: FormData) {
  if (isPreview()) return { ok: true };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");

  const conversationId = String(formData.get("conversationId") || "");
  const caption = String(formData.get("caption") || "").trim();
  const file = formData.get("file") as File | null;
  if (!conversationId || !file || file.size === 0) return { ok: false };

  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("contact_phone, channel_id, status, is_group, contact_jid, assigned_user_id")
    .eq("id", conversationId)
    .single();
  if (!conv) throw new Error("Conversa não encontrada.");

  // Canal buscado ANTES do upload: canais Meta precisam de conversão de áudio.
  const { data: channel } = await supabase.from("channels").select("*").eq("id", conv.channel_id).single();

  const override = String(formData.get("kind") || "");
  const { kind, content } =
    override === "sticker"
      ? ({ kind: "sticker", content: "sticker" } as const)
      : kindFromMime(file.type || "");

  // Upload pro bucket público "media" (service client ignora RLS no storage).
  const svc = createServiceClient();
  let buf: Buffer = Buffer.from(await file.arrayBuffer());
  let ext = (file.name?.split(".").pop() || (file.type.split("/")[1] ?? "bin")).slice(0, 5);
  let contentType = file.type || "application/octet-stream";

  // A Cloud API da Meta NÃO aceita webm (formato que o navegador grava). Converte
  // pra ogg/opus antes de subir — só nos canais Meta e só quando é áudio webm.
  if (content === "audio" && (channel as { type?: string })?.type === "meta_cloud" && /webm/i.test(`${contentType} ${ext}`)) {
    const ogg = await toOggOpus(buf);
    if (ogg) { buf = ogg; ext = "ogg"; contentType = "audio/ogg"; }
  }

  const path = `${session.organization.id}/out/${conversationId}-${Date.now()}.${ext}`;
  const up = await svc.storage
    .from("media")
    .upload(path, buf, { contentType, upsert: true });
  if (up.error) throw new Error("Falha ao subir o arquivo.");
  const publicUrl = svc.storage.from("media").getPublicUrl(path).data.publicUrl;

  // Registra a mensagem (pendente) e envia pelo provedor.
  const { data: msg } = await supabase
    .from("messages")
    .insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "agent",
      sender_id: session.userId,
      content_type: content,
      body: caption || null,
      media_url: publicUrl,
      status: "pending",
    })
    .select("id")
    .single();

  try {
    const to = recipientOf(conv);
    const res = await getProvider(channel as Channel).sendMedia({ to, url: publicUrl, caption, kind });
    await supabase.from("messages").update({ status: "sent", external_id: res.externalId ?? null }).eq("id", msg!.id);
  } catch (e) {
    console.error("sendMedia error", e);
    await supabase.from("messages").update({ status: "failed" }).eq("id", msg!.id);
  }

  await supabase
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      status: conv.status === "closed" ? "open" : conv.status,
      // Quem responde (com mídia) também ASSUME a conversa se ela não tem dono.
      ...(!conv.assigned_user_id ? { assigned_user_id: session.userId, offered_to: null } : {}),
    })
    .eq("id", conversationId);
  revalidatePath("/atendimento");
  return { ok: true };
}

/** Destinatário do provedor: para grupos usa o JID completo (preserva traço). */
function recipientOf(conv: { contact_phone: string; is_group?: boolean; contact_jid?: string | null }) {
  if (conv.is_group) return conv.contact_jid || `${conv.contact_phone}@g.us`;
  return conv.contact_phone;
}

async function recipientFor(supabase: Awaited<ReturnType<typeof createClient>>, conversationId: string) {
  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("contact_phone, channel_id, is_group, contact_jid")
    .eq("id", conversationId)
    .single();
  if (!conv) throw new Error("Conversa não encontrada.");
  const { data: channel } = await supabase.from("channels").select("*").eq("id", conv.channel_id).single();
  return { to: recipientOf(conv), channel: channel as Channel };
}

/** Reage a uma mensagem com um emoji (vazio remove a reação). */
export async function reactToMessage(conversationId: string, messageId: string, emoji: string) {
  if (isPreview()) return { ok: true };
  const supabase = await createClient();
  const { data: m } = await supabase.from("messages").select("external_id, reactions").eq("id", messageId).single();
  if (!m?.external_id) return { ok: false };
  const { to, channel } = await recipientFor(supabase, conversationId);
  try {
    await getProvider(channel).reactMessage?.(to, m.external_id, emoji);
  } catch (e) {
    console.error("react error", e);
  }
  const current = Array.isArray(m.reactions) ? (m.reactions as { emoji: string; by: string }[]) : [];
  const without = current.filter((r) => r.by !== "Você");
  const next = emoji ? [...without, { emoji, by: "Você" }] : without;
  await supabase.from("messages").update({ reactions: next }).eq("id", messageId);
  revalidatePath("/atendimento");
  return { ok: true };
}

/** Edita o texto de uma mensagem enviada. */
export async function editMessageAction(conversationId: string, messageId: string, newText: string) {
  if (isPreview()) return { ok: true };
  const text = newText.trim();
  if (!text) return { ok: false };
  const supabase = await createClient();
  const { data: m } = await supabase.from("messages").select("external_id").eq("id", messageId).single();
  if (!m?.external_id) return { ok: false };
  const { channel } = await recipientFor(supabase, conversationId);
  try {
    await getProvider(channel).editMessage?.(m.external_id, text);
  } catch (e) {
    console.error("edit error", e);
  }
  await supabase.from("messages").update({ body: text, edited: true }).eq("id", messageId);
  revalidatePath("/atendimento");
  return { ok: true };
}

/**
 * Apaga uma mensagem.
 * - scope "everyone": revoga no WhatsApp do cliente (quando o canal suporta) e marca na plataforma.
 * - scope "me": apenas na plataforma (o cliente mantém a mensagem).
 * Em ambos os casos a mensagem PERMANECE no banco (faded na UI) para auditoria/admin —
 * o conteúdo não é apagado.
 */
export async function deleteMessageAction(
  conversationId: string,
  messageId: string,
  scope: "me" | "everyone" = "everyone",
) {
  if (isPreview()) return { ok: true };
  const supabase = await createClient();
  let revoked = false;
  if (scope === "everyone") {
    const { data: m } = await supabase.from("messages").select("external_id").eq("id", messageId).single();
    const { channel } = await recipientFor(supabase, conversationId);
    try {
      if (m?.external_id && getProvider(channel).deleteMessage) {
        await getProvider(channel).deleteMessage!(m.external_id);
        revoked = true;
      }
    } catch (e) {
      console.error("delete error", e);
      void logEvent("error", "send", `Falha ao revogar mensagem: ${(e as Error)?.message}`, { conversationId });
    }
  }
  // Mantém body/media (auditoria); só marca como apagada + o escopo.
  await supabase.from("messages").update({ is_deleted: true, deleted_scope: scope }).eq("id", messageId);
  revalidatePath("/atendimento");
  return { ok: true, revoked };
}

/** Marca as mensagens recebidas da conversa como lidas (✓✓ azul no WhatsApp). */
export async function markConversationRead(conversationId: string) {
  if (isPreview()) return { ok: true };
  const supabase = await createClient();
  const { data: msgs } = await supabase
    .from("messages")
    .select("id, external_id")
    .eq("conversation_id", conversationId)
    .eq("direction", "in")
    .neq("status", "read")
    .limit(200);
  const ids = (msgs ?? []).map((m) => m.external_id).filter(Boolean) as string[];
  if (!ids.length) return { ok: true };
  try {
    const { channel } = await recipientFor(supabase, conversationId);
    await getProvider(channel).markRead?.(ids);
  } catch (e) {
    console.warn("markRead", (e as Error)?.message);
  }
  await supabase.from("messages").update({ status: "read" }).eq("conversation_id", conversationId).eq("direction", "in");
  return { ok: true };
}

/** Envia uma localização na conversa. */
export async function sendLocationMessage(
  conversationId: string,
  loc: { latitude: number; longitude: number; name?: string; address?: string },
) {
  if (isPreview()) return { ok: true };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();
  const { to, channel } = await recipientFor(supabase, conversationId);
  const label = loc.name || loc.address || `${loc.latitude}, ${loc.longitude}`;
  const { data: msg } = await supabase
    .from("messages")
    .insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "agent",
      sender_id: session.userId,
      content_type: "location",
      body: `📍 ${label}\nhttps://maps.google.com/?q=${loc.latitude},${loc.longitude}`,
      status: "pending",
    })
    .select("id")
    .single();
  try {
    const res = await getProvider(channel).sendLocation?.(to, loc);
    await supabase.from("messages").update({ status: "sent", external_id: res?.externalId ?? null }).eq("id", msg!.id);
  } catch (e) {
    console.error("sendLocation", e);
    await supabase.from("messages").update({ status: "failed" }).eq("id", msg!.id);
  }
  await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);
  revalidatePath("/atendimento");
  return { ok: true };
}

/** Envia um contato (vCard) na conversa. */
export async function sendContactMessage(conversationId: string, fullName: string, phoneNumber: string) {
  if (isPreview()) return { ok: true };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const name = fullName.trim();
  const phone = phoneNumber.replace(/\D/g, "");
  if (!name || !phone) return { ok: false };
  const supabase = await createClient();
  const { to, channel } = await recipientFor(supabase, conversationId);
  const { data: msg } = await supabase
    .from("messages")
    .insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "agent",
      sender_id: session.userId,
      content_type: "contact",
      body: `👤 ${name} — ${phone}`,
      status: "pending",
    })
    .select("id")
    .single();
  try {
    const res = await getProvider(channel).sendContact?.(to, { fullName: name, phoneNumber: phone });
    await supabase.from("messages").update({ status: "sent", external_id: res?.externalId ?? null }).eq("id", msg!.id);
  } catch (e) {
    console.error("sendContact", e);
    await supabase.from("messages").update({ status: "failed" }).eq("id", msg!.id);
  }
  await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);
  revalidatePath("/atendimento");
  return { ok: true };
}

/**
 * Pausa (assume) ou reativa o atendimento por IA nesta conversa.
 * - Pausar (enabled=false): atendente assume; o chatbot não reengaja, mesmo
 *   em mensagem nova (block_return_to_bot por conversa).
 * - Reativar (enabled=true): devolve a conversa para a automação (status "bot").
 */
export async function setConversationAi(conversationId: string, enabled: boolean) {
  if (isPreview()) return { enabled };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();

  const patch: Record<string, unknown> = { ai_enabled: enabled };
  if (enabled) {
    patch.status = "bot";
  } else {
    patch.status = "open";
    patch.assigned_user_id = session.userId;
  }
  await supabase.from("conversations").update(patch).eq("id", conversationId);
  void logEvent("info", "atendente", `${session.profile?.name ?? "Atendente"} ${enabled ? "reativou a IA" : "pausou a IA"}`, { conversationId, userId: session.userId, action: enabled ? "ativar_ia" : "pausar_ia" }, session.organization.id);

  await supabase.from("messages").insert({
    organization_id: session.organization.id,
    conversation_id: conversationId,
    direction: "out",
    sender_type: "system",
    content_type: "text",
    body: enabled
      ? `Atendimento devolvido para a IA${session.profile?.name ? ` por ${session.profile.name}` : ""}.`
      : `IA pausada — atendimento assumido${session.profile?.name ? ` por ${session.profile.name}` : ""}.`,
    is_internal: true,
    status: "sent",
  });

  revalidatePath("/atendimento");
  return { enabled };
}

/** Silencia/dessilencia uma conversa (grupo ou contato). */
export async function toggleMute(conversationId: string, muted: boolean) {
  if (isPreview()) return { muted };
  const supabase = await createClient();
  await supabase.from("conversations").update({ is_muted: muted }).eq("id", conversationId);
  revalidatePath("/atendimento");
  return { muted };
}

export interface TransferOptions {
  toUserId?: string | null;
  toUserIds?: string[]; // oferecer a VÁRIOS colegas — o primeiro que assumir fica.
  toDepartmentId?: string | null;
  internalNote?: string;
  customerMessage?: string;
}

/**
 * Transferência avançada: para uma pessoa e/ou departamento, com nota interna
 * (só atendentes) e mensagem ao cliente (enviada de verdade).
 */
export async function transferConversation(conversationId: string, opts: TransferOptions) {
  if (isPreview()) return { ok: true };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const supabase = await createClient();

  const offerIds = (opts.toUserIds ?? []).filter(Boolean);
  const update: Record<string, unknown> = {};
  if (opts.toDepartmentId !== undefined) update.department_id = opts.toDepartmentId || null;
  if (opts.toUserId) {
    // Transfere para UMA pessoa: vira dona; limpa qualquer oferta pendente.
    update.assigned_user_id = opts.toUserId;
    update.status = "open";
    update.offered_to = null;
  } else if (offerIds.length) {
    // OFERECE para vários colegas: fica sem dono, na fila, visível só para os
    // escolhidos (+ admin). O primeiro que responder/assumir "pega" e some dos
    // demais (assumir/responder limpa offered_to).
    update.assigned_user_id = null;
    update.status = "queued";
    update.offered_to = offerIds;
  } else if (opts.toDepartmentId) {
    // Volta para a fila do departamento, sem atendente específico.
    update.assigned_user_id = null;
    update.status = "queued";
    update.offered_to = null;
  }
  if (Object.keys(update).length) {
    await supabase.from("conversations").update(update).eq("id", conversationId);
  }

  // Marcador de transferência VISÍVEL no histórico (interno, não vai ao cliente).
  // Deixa claro por que a conversa mudou de dono — evita a impressão de
  // "atribuição errada" para quem abre a conversa depois.
  {
    const actor = session.profile?.name ?? "Atendente";
    let alvo = "";
    if (opts.toUserId) {
      const { data: prof } = await supabase.from("profiles").select("name").eq("id", opts.toUserId).maybeSingle();
      alvo = prof?.name ? `para ${prof.name}` : "para outro atendente";
    } else if (offerIds.length) {
      const { data: profs } = await supabase.from("profiles").select("name").in("id", offerIds);
      const nomes = (profs ?? []).map((p) => p.name).filter(Boolean).join(", ");
      alvo = nomes ? `para ${nomes} (o primeiro que assumir fica)` : "para vários atendentes (o primeiro que assumir fica)";
    } else if (opts.toDepartmentId) {
      const { data: dept } = await supabase.from("departments").select("name").eq("id", opts.toDepartmentId).maybeSingle();
      alvo = dept?.name ? `para a fila do departamento ${dept.name}` : "para a fila do departamento";
    }
    if (alvo) {
      await supabase.from("messages").insert({
        organization_id: session.organization.id,
        conversation_id: conversationId,
        direction: "out",
        sender_type: "system",
        sender_id: session.userId,
        content_type: "text",
        body: `🔄 ${actor} transferiu este atendimento ${alvo}.`,
        is_internal: true,
        status: "sent",
      });
    }
  }

  // Nota interna de transferência (não vai ao cliente).
  if (opts.internalNote?.trim()) {
    await supabase.from("messages").insert({
      organization_id: session.organization.id,
      conversation_id: conversationId,
      direction: "out",
      sender_type: "system",
      sender_id: session.userId,
      content_type: "text",
      body: opts.internalNote.trim(),
      is_internal: true,
      status: "sent",
    });
  }

  // Mensagem ao cliente (enviada pelo provedor).
  if (opts.customerMessage?.trim()) {
    // autoClaim=false: numa transferência (ex.: para a fila) não deixar que o
    // envio da mensagem ao cliente re-atribua a conversa a quem transferiu.
    await sendMessage(conversationId, opts.customerMessage.trim(), undefined, undefined, false);
  }

  void logEvent("info", "atendente", `${session.profile?.name ?? "Atendente"} transferiu o atendimento`, { conversationId, userId: session.userId, action: "transferir", toUserId: opts.toUserId ?? null, toDepartmentId: opts.toDepartmentId ?? null }, session.organization.id);
  revalidatePath("/atendimento");
  return { ok: true };
}

/** Fixa/desfixa uma conversa. */
export async function togglePin(conversationId: string, pinned: boolean) {
  if (isPreview()) return { pinned };
  const supabase = await createClient();
  await supabase.from("conversations").update({ pinned }).eq("id", conversationId);
  revalidatePath("/atendimento");
  return { pinned };
}

/** Arquiva/desarquiva uma conversa. */
export async function toggleArchive(conversationId: string, archived: boolean) {
  if (isPreview()) return { archived };
  const supabase = await createClient();
  await supabase.from("conversations").update({ archived }).eq("id", conversationId);
  revalidatePath("/atendimento");
  return { archived };
}

/** Busca conversas por protocolo (global). */
export async function searchByProtocol(protocol: string) {
  if (isPreview()) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversation_overview")
    .select("id, protocol, contact_name, contact_phone, status")
    .ilike("protocol", `%${protocol.trim()}%`)
    .limit(20);
  return data ?? [];
}

/** Ação SGP manual no painel do contato (2ª via, PIX, liberação, status). */
/**
 * Busca um CPF/CNPJ em TODAS as contas SGP da org (multi-cidade) e devolve os
 * dados do cadastro para autopreencher o painel do contato. Usa o contrato com
 * débito (ou o primeiro) para plano/status/endereço.
 */
export interface SgpContrato {
  contrato: string;
  plano?: string;
  status?: string;
  endereco?: string;
  valorEmAberto?: number;
  sgp?: string; // rótulo do SGP/cidade de onde veio (multi-SGP)
}
export interface SgpLookupResult {
  encontrado: boolean;
  erro?: string;
  nome?: string;
  cpfcnpj?: string;
  email?: string;
  contratos: SgpContrato[]; // TODOS os contratos, de TODOS os SGPs
}

/** Rótulo amigável do SGP a partir da URL da config (Nova Canaã vs. principal). */
function sgpLabelFromUrl(url?: unknown): string {
  const h = String(url ?? "").toLowerCase();
  if (h.includes("canaa") || h.includes("canã")) return "Nova Canaã";
  return "Iguaí/Ibicuí";
}

/**
 * Busca o CPF/CNPJ em TODOS os SGPs e devolve TODOS os contratos encontrados
 * (não para no primeiro SGP nem no primeiro contrato). A UI deixa o atendente
 * escolher qual contrato usar. Cada contrato carrega o rótulo do SGP de origem.
 */
export async function sgpLookupByCpf(cpfcnpj: string): Promise<SgpLookupResult> {
  if (isPreview()) return { encontrado: false, erro: "Modo preview.", contratos: [] };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const cpf = String(cpfcnpj || "").replace(/\D+/g, "");
  if (cpf.length < 11) return { encontrado: false, erro: "Informe um CPF (11) ou CNPJ (14) válido.", contratos: [] };

  const supabase = await createClient();
  const { sgpFromConfig } = await import("@/lib/sgp");
  const { data: integs } = await supabase
    .from("integrations")
    .select("config")
    .eq("organization_id", session.organization.id)
    .eq("type", "sgp")
    .eq("active", true);

  const sources = ((integs ?? []) as { config: { url?: string } }[])
    .map((r) => { try { return { client: sgpFromConfig(r.config), label: sgpLabelFromUrl(r.config?.url) }; } catch { return null; } })
    .filter((s): s is NonNullable<typeof s> => !!s);
  if (!sources.length) return { encontrado: false, erro: "Nenhum SGP configurado.", contratos: [] };

  const contratos: SgpContrato[] = [];
  let nome: string | undefined;
  let cpfOut: string | undefined;
  let email: string | undefined;
  const seen = new Set<string>();

  for (const { client, label } of sources) {
    const c = await client.consultarCliente({ cpfcnpj: cpf }).catch(() => null);
    if (!c?.encontrado || !c.contratos.length) continue;
    nome = nome ?? c.nome ?? "";
    cpfOut = cpfOut ?? c.cpfcnpj ?? cpf;
    email = email || c.emails?.[0] || undefined;
    for (const x of c.contratos) {
      const key = `${label}:${x.contrato}`;
      if (seen.has(key)) continue;
      seen.add(key);
      contratos.push({
        contrato: x.contrato ? String(x.contrato) : "",
        plano: x.plano ?? "",
        status: x.status ?? "",
        endereco: x.endereco ?? "",
        valorEmAberto: x.valorEmAberto,
        sgp: label,
      });
    }
  }

  if (!contratos.length) return { encontrado: false, erro: "Cadastro não localizado no SGP.", contratos: [] };
  // Ordena: contratos com fatura em aberto primeiro (é o que o atendente busca).
  contratos.sort((a, b) => (b.valorEmAberto ?? 0) - (a.valorEmAberto ?? 0));
  return { encontrado: true, nome, cpfcnpj: cpfOut ?? cpf, email, contratos };
}

export async function sgpAction(conversationId: string, action: string, contrato: number): Promise<string> {
  if (isPreview()) return "Modo preview.";
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const { sgpFromConfig } = await import("@/lib/sgp");
  const supabase = await createClient();
  const { data: integs } = await supabase
    .from("integrations").select("config")
    .eq("organization_id", session.organization.id).eq("type", "sgp").eq("active", true);
  const clients = ((integs ?? []) as { config: unknown }[])
    .map((r) => { try { return sgpFromConfig(r.config); } catch { return null; } })
    .filter((c): c is NonNullable<typeof c> => !!c);
  if (!clients.length) return "SGP não configurado. Cadastre a integração em Ajustes > Integrações.";
  // Acha o SGP que TEM esse contrato (multi-cidade: Iguaí, Nova Canaã, etc.).
  let sgp = clients[0];
  for (const cli of clients) {
    const c = await cli.consultarCliente({ contrato }).catch(() => null);
    if (c?.encontrado) { sgp = cli; break; }
  }
  try {
    switch (action) {
      case "segunda_via": {
        const r = await sgp.segundaVia({ contrato });
        if (!r.ok) return r.mensagem ?? "Erro ao gerar 2ª via.";
        const lines = r.faturas.map((f) =>
          `Fatura ${f.fatura}: R$ ${f.valor?.toFixed(2)} (venc. ${f.vencimento})${f.linhaDigitavel ? `\nLinha: ${f.linhaDigitavel}` : ""}${f.link ? `\nLink: ${f.link}` : ""}`,
        );
        return lines.length ? lines.join("\n\n") : "Nenhuma fatura encontrada.";
      }
      case "pix": {
        // Pega a 1ª fatura em aberto
        const titulos = await sgp.titulosEmAberto({ contrato });
        if (!titulos.length) return "Nenhuma fatura em aberto.";
        const px = await sgp.gerarPix(titulos[0].fatura, contrato);
        return px.codigoPix ?? "PIX não disponível para esta fatura.";
      }
      case "liberacao": {
        const r = await sgp.liberacaoConfianca({ contrato });
        return r.ok ? `Liberado! Protocolo: ${r.protocolo ?? "—"}` : (r.mensagem ?? "Não foi possível liberar.");
      }
      case "status": {
        const r = await sgp.statusConexao({ contrato });
        return r.online ? "Conexão ONLINE" : `Conexão OFFLINE${r.mensagem ? ` — ${r.mensagem}` : ""}`;
      }
      default:
        return "Ação desconhecida.";
    }
  } catch (e) {
    return `Erro SGP: ${(e as Error)?.message ?? "desconhecido"}`;
  }
}

/** "2026-08-25" -> "25/08/2026" (deixa passar o que já vier em outro formato). */
function fmtVenc(v?: string): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

/**
 * Gera o PIX copia-e-cola da fatura mais antiga em aberto e ENVIA direto ao cliente na
 * conversa (não só devolve o texto). Busca em todos os SGPs configurados para
 * achar o que tem esse contrato — cobre operação multi-cidade (Iguaí, Nova
 * Canaã, etc.). Usado pelo botão "PIX" na aba Financeiro do atendimento.
 */
export async function sgpSendPix(conversationId: string, contrato: number): Promise<{ ok: boolean; message: string }> {
  if (isPreview()) return { ok: true, message: "Modo preview." };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  if (!contrato || Number.isNaN(contrato)) return { ok: false, message: "Contrato inválido." };

  const supabase = await createClient();
  const { sgpFromConfig } = await import("@/lib/sgp");
  const { data: integs } = await supabase
    .from("integrations")
    .select("config")
    .eq("organization_id", session.organization.id)
    .eq("type", "sgp")
    .eq("active", true);

  const clients = ((integs ?? []) as { config: unknown }[])
    .map((r) => { try { return sgpFromConfig(r.config); } catch { return null; } })
    .filter((c): c is NonNullable<typeof c> => !!c);
  if (!clients.length) return { ok: false, message: "Nenhum SGP configurado." };

  // Acha o SGP que tem fatura em aberto para este contrato e gera o PIX da
  // fatura MAIS ANTIGA em aberto (titulosEmAberto já ordena por vencimento e
  // descarta canceladas) — nunca de uma parcela futura.
  let codigoPix: string | null = null;
  let alvo: { fatura: number; valor?: number; vencimento?: string } | null = null;
  for (const sgp of clients) {
    const titulos = await sgp.titulosEmAberto({ contrato }).catch(() => [] as Awaited<ReturnType<typeof sgp.titulosEmAberto>>);
    if (!titulos.length) continue;
    const t = titulos[0];
    const px = await sgp.gerarPix(t.fatura, contrato).catch(() => null);
    if (px?.codigoPix) { codigoPix = px.codigoPix; alvo = { fatura: t.fatura, valor: t.valor, vencimento: t.vencimento }; break; }
  }
  if (!codigoPix || !alvo) return { ok: false, message: "Nenhuma fatura em aberto (ou PIX indisponível) para este contrato." };

  // Envia ao cliente: uma mensagem de instrução + o código copia-e-cola sozinho
  // (numa mensagem separada, pra facilitar o copiar).
  const { to, channel } = await recipientFor(supabase, conversationId);
  const venc = fmtVenc(alvo.vencimento);
  const val = typeof alvo.valor === "number" ? `R$ ${alvo.valor.toFixed(2).replace(".", ",")}` : null;
  const ref = [val, venc ? `venc. ${venc}` : null].filter(Boolean).join(" — ");
  const intro = `Segue o PIX *copia e cola* da sua fatura${ref ? ` (${ref})` : ""}. É só tocar em *Copiar código PIX* e pagar pelo app do seu banco: 👇`;
  const provider = getProvider(channel);
  const orgId = session.organization.id;

  const insertOut = async (body: string, contentType: string = "text") => {
    const { data } = await supabase.from("messages").insert({
      organization_id: orgId, conversation_id: conversationId,
      direction: "out", sender_type: "agent", sender_id: session.userId,
      content_type: contentType, body, status: "pending",
    }).select("id").single();
    return data?.id as string | undefined;
  };
  const mark = (id: string | undefined, ok: boolean, ext?: string) =>
    id && supabase.from("messages").update({ status: ok ? "sent" : "failed", external_id: ext ?? null }).eq("id", id);

  let allOk = true;
  let done = false;
  // Tenta o card/botão interativo (uazapi: botão copiar; Meta: card order_details).
  if (typeof provider.sendPixCard === "function") {
    try {
      const res = await provider.sendPixCard({
        to, text: intro, code: codigoPix, buttonLabel: "Copiar código PIX",
        amountCents: typeof alvo.valor === "number" ? Math.round(alvo.valor * 100) : undefined,
        merchantName: "MVF NET", pixKey: "07861662000103", pixKeyType: "CNPJ",
        refId: String(alvo.fatura), itemName: `Fatura ${alvo.fatura}`,
      });
      if (!res.unsupported) {
        // No histórico guardamos texto + código pra o atendente ver o que foi enviado.
        await supabase.from("messages").insert({
          organization_id: orgId, conversation_id: conversationId, direction: "out",
          sender_type: "agent", sender_id: session.userId, content_type: "text",
          body: `${intro}\n\n${codigoPix}`, external_id: res.externalId ?? null, status: "sent",
        });
        done = true;
      }
    } catch (e) { console.error("sgpSendPix card", e); /* cai no texto abaixo */ }
  }
  // Fallback texto: intro + código (o cliente segura o código e copia).
  if (!done) {
    for (const body of [intro, codigoPix]) {
      const id = await insertOut(body);
      try {
        const res = await provider.sendText({ to, text: body });
        await mark(id, true, res?.externalId);
      } catch (e) { allOk = false; console.error("sgpSendPix text", e); await mark(id, false); }
    }
  }

  await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);
  void logEvent("info", "atendente", `${session.profile?.name ?? "Atendente"} enviou PIX ao cliente (contrato ${contrato}, fatura ${alvo.fatura}${venc ? `, venc. ${venc}` : ""})`, { conversationId, userId: session.userId, action: "enviar_pix", fatura: alvo.fatura, vencimento: alvo.vencimento }, session.organization.id);
  revalidatePath("/atendimento");
  return allOk
    ? { ok: true, message: `PIX enviado ao cliente ✅\n\nFatura ${alvo.fatura}${ref ? ` — ${ref}` : ""}\n(a mais antiga em aberto)` }
    : { ok: false, message: "Não foi possível enviar o PIX ao cliente. Tente novamente." };
}

/** Remove um participante de um grupo WhatsApp. */
export async function removeGroupParticipant(conversationId: string, phone: string): Promise<{ ok: boolean; error?: string }> {
  if (isPreview()) return { ok: false, error: "Modo preview." };
  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversation_overview")
    .select("channel_id, is_group, contact_jid, contact_phone")
    .eq("id", conversationId)
    .single();
  if (!conv?.is_group) return { ok: false, error: "Não é um grupo." };
  const { data: channel } = await supabase.from("channels").select("*").eq("id", conv.channel_id).single();
  if (!channel) return { ok: false, error: "Canal não encontrado." };
  const jid = (conv.contact_jid as string) || `${conv.contact_phone}@g.us`;
  const provider = getProvider(channel as Channel);
  if (!provider.removeGroupParticipant) return { ok: false, error: "Provedor não suporta remoção de participantes." };
  const ok = await provider.removeGroupParticipant(jid, phone);
  return ok ? { ok: true } : { ok: false, error: "Falha ao remover participante." };
}
