import { createServiceClient } from "@/lib/supabase/server";
import type { InboundMessage } from "./types";
import type { Channel } from "@/lib/types";
import { storeInboundMedia } from "./media";
import { rehostImageUrl } from "./avatar";
import { runChatbot } from "./chatbot";
import { getProvider } from "./index";
import { logEvent } from "@/lib/log";

// Cache de participantes por grupo (5 min) para resolver menções sem bater toda hora.
const groupPartsCache = new Map<string, { at: number; parts: { phone: string; lid: string }[] }>();

// Mutex por conversa: serializa os turnos do bot DENTRO do processo. Sem isto,
// mensagens do cliente em sequência ("Sim" → "internet lenta" → CPF) que escapam
// do debounce disparam runChatbot concorrentes que atropelam bot_node_id/histórico
// — a IA re-saúda ("você já é nosso cliente?") e ferramentas rodam 2×. O app roda
// em processo único (Easypanel), então um lock em memória basta.
const convChains = new Map<string, Promise<unknown>>();
function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = convChains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  convChains.set(key, next);
  // Libera a chave quando esta for a última execução na fila (evita vazamento).
  next.catch(() => {}).finally(() => {
    if (convChains.get(key) === next) convChains.delete(key);
  });
  return next;
}

/** Troca "@<número/lid>" no texto pelo nome do participante (resolvido via grupo + contatos). */
async function resolveMentions(db: DB, channel: Channel, groupJid: string, body: string): Promise<string> {
  if (!/@\d{5,}/.test(body)) return body;

  // 1) Cache de participantes do grupo (LID → phone).
  let cached = groupPartsCache.get(groupJid);
  if (!cached || Date.now() - cached.at > 300000) {
    const info = await getProvider(channel).getGroupInfo?.(groupJid).catch(() => null);
    cached = { at: Date.now(), parts: info?.participants ?? [] };
    groupPartsCache.set(groupJid, cached);
  }

  // Mapa: qualquer forma de ID (lid, phone, lid parcial) → phone real.
  const toPhone = new Map<string, string>();
  for (const p of cached.parts) {
    if (p.lid) toPhone.set(p.lid, p.phone);
    if (p.phone) toPhone.set(p.phone, p.phone);
    // LIDs podem ter sufixos/prefixos — registra os últimos 10-15 dígitos também.
    if (p.lid && p.lid.length > 10) toPhone.set(p.lid.slice(-12), p.phone);
  }

  // 2) Nomes dos contatos.
  const phones = [...new Set([...toPhone.values()])];
  const names = new Map<string, string>();
  if (phones.length) {
    const { data: contacts } = await db.from("contacts").select("phone, name").in("phone", phones);
    for (const c of contacts ?? []) if (c.name) names.set(c.phone, c.name);
  }

  // 3) Pré-carrega nomes por author_lid de mensagens recentes deste grupo.
  const lidNames = new Map<string, string>();
  const { data: recentMsgs } = await db
    .from("messages")
    .select("author_lid, author_name")
    .not("author_lid", "is", null)
    .not("author_name", "is", null)
    .limit(200);
  for (const m of (recentMsgs ?? []) as { author_lid: string; author_name: string }[]) {
    if (m.author_lid && m.author_name) {
      lidNames.set(m.author_lid, m.author_name);
      // Match parcial (últimos dígitos).
      if (m.author_lid.length > 8) lidNames.set(m.author_lid.slice(-12), m.author_name);
    }
  }

  // 4) Substitui @digits pelo nome.
  return body.replace(/@(\d{5,})/g, (full, digits: string) => {
    // Tenta via participantes do grupo.
    const phone = toPhone.get(digits);
    if (phone) {
      const name = names.get(phone);
      if (name) return `@${name}`;
    }
    // Tenta via author_lid de mensagens (match exato e parcial).
    const fromLid = lidNames.get(digits) ?? lidNames.get(digits.slice(-12));
    if (fromLid) return `@${fromLid}`;
    // Tenta como telefone direto nos contatos.
    const fromPhone = names.get(digits);
    if (fromPhone) return `@${fromPhone}`;
    // Último recurso: mantém o original.
    return full;
  });
}

const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker"]);

/**
 * Verifica se o horário atual (ajustado pelo tzOffset) está dentro de alguma faixa
 * do schedule da automação. Retorna true se schedule for null/undefined (sem restrição).
 */
function isWithinSchedule(schedule: unknown, tzOffset: number): boolean {
  if (!schedule || typeof schedule !== "object") return true;
  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const now = new Date(Date.now() + tzOffset * 3600000);
  const dayKey = DAY_KEYS[now.getUTCDay()];
  const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const ranges = (schedule as Record<string, unknown>)[dayKey];
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  return ranges.some(
    (r) => Array.isArray(r) && r.length === 2 && hhmm >= (r[0] as string) && hhmm <= (r[1] as string),
  );
}

/** Hash curto e estável para cache-busting da foto re-hospedada. */
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Persiste mensagens recebidas via webhook: localiza o canal pelo external_id,
 * faz upsert do contato e da conversa em aberto, e grava a mensagem.
 * Usa o service client (ignora RLS) — só deve ser chamado por rotas de webhook.
 */
export async function persistInbound(messages: InboundMessage[]) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const db = createServiceClient();

  for (const msg of messages) {
    if (!msg.channelExternalId || !msg.from) continue;

    // Conversas de GRUPO não entram na aplicação: descarta antes de criar
    // contato/conversa/mensagem. O atendimento é 1:1 — grupo só gerava ruído
    // na caixa de entrada. (Também cobre as reações vindas de grupo.)
    if (msg.isGroup || String(msg.chatJid ?? "").endsWith("@g.us")) continue;

    const { data: channel } = await db
      .from("channels")
      .select("*")
      .eq("external_id", msg.channelExternalId)
      .maybeSingle();
    if (!channel) continue;

    // Reação: anexa o emoji à mensagem-alvo e segue (não cria mensagem nova).
    if (msg.reaction) {
      await applyReaction(db, msg.reaction.targetExternalId, msg.reaction.emoji, msg.authorName ?? "contato").catch(
        (e) => console.warn("reaction", (e as Error)?.message),
      );
      continue;
    }

    const org = channel.organization_id;
    const isGroup = !!msg.isGroup;
    const fromMe = !!msg.fromMe; // eco do próprio número (enviado pelo celular) → direção "out"

    // Dedup: ignora se já gravamos essa mensagem (mesmo external_id).
    if (msg.externalId) {
      const { data: dup } = await db.from("messages").select("id").eq("external_id", msg.externalId).limit(1).maybeSingle();
      if (dup) continue;
    }

    // Contato/grupo (upsert por organização + telefone/id).
    // Para mensagens fromMe (eco do celular) em 1:1, NÃO passamos nome —
    // o chat.name do webhook vem com o nome do DONO, não do contato.
    const contactName = (fromMe && !isGroup) ? null : (msg.contactName ?? null);
    const { data: contact } = await db
      .from("contacts")
      .upsert(
        {
          organization_id: org,
          phone: msg.from,
          name: contactName,
          is_group: isGroup,
        },
        { onConflict: "organization_id,phone", ignoreDuplicates: false },
      )
      .select("id, name, avatar_url, avatar_src, is_group")
      .single();

    // Nome e foto vêm no objeto `chat` do webhook (contato e grupo). Preenche o que faltar.
    // Não usa chatName em fromMe 1:1 (viria o nome do dono, não do contato).
    if (contact) {
      const patch: Record<string, unknown> = {};
      if (!contact.name && msg.chatName && !(fromMe && !isGroup)) patch.name = msg.chatName;
      if (isGroup && msg.chatJid) patch.chat_jid = msg.chatJid; // JID completo do grupo
      // Foto: re-hospeda no nosso Storage. "src" = caminho da URL do WhatsApp (sem query
      // de expiração) — muda quando a pessoa troca a foto → re-hospeda a nova.
      const srcKey = msg.chatPhoto ? msg.chatPhoto.split("?")[0] : null;
      const changed = srcKey && srcKey !== contact.avatar_src;
      if (changed && msg.chatPhoto) {
        const durable = await rehostImageUrl(db, org, contact.id, msg.chatPhoto).catch(() => null);
        if (durable) {
          patch.avatar_url = `${durable}?v=${hashStr(srcKey)}`; // cache-busting ao trocar
          patch.avatar_src = srcKey;
        }
      }
      if (Object.keys(patch).length) await db.from("contacts").update(patch).eq("id", contact.id);
    }

    // Configurações da org: lidas uma vez e reaproveitadas para schedule,
    // business_hours e close_command mais adiante.
    const { data: orgRow } = await db
      .from("organizations")
      .select("settings")
      .eq("id", org)
      .maybeSingle();
    const orgSettings = (orgRow?.settings ?? {}) as Record<string, unknown>;
    const tzOffset = (orgSettings.timezone_offset as number) ?? -3;

    // Automação ativa do canal (chatbot). Grupos não entram no bot.
    const { data: automation } = isGroup
      ? { data: null }
      : await db
          .from("automations")
          .select("id, flow, active, channel_id, integration_id, schedule")
          .eq("organization_id", org)
          .eq("active", true)
          .or(`channel_id.eq.${channel.id},channel_id.is.null`)
          .order("channel_id", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();

    // Verifica se a automação está dentro do horário configurado.
    // Se tiver schedule e a hora atual estiver fora, trata como sem automação.
    const automationActive = automation
      ? isWithinSchedule((automation as { schedule?: unknown }).schedule, tzOffset)
      : false;

    // Conversa em aberto (reaproveita ou cria)
    let conversationId: string;
    let convStatus = "queued";
    let convBotNode: string | null = null;
    let convAiEnabled = true;
    let isNew = false;
    const { data: existing } = await db
      .from("conversations")
      .select("id, status, bot_node_id, ai_enabled")
      .eq("channel_id", channel.id)
      .eq("contact_id", contact!.id)
      .in("status", ["bot", "queued", "open"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      conversationId = existing.id;
      convStatus = existing.status;
      convBotNode = existing.bot_node_id;
      convAiEnabled = (existing as { ai_enabled?: boolean }).ai_enabled !== false;
    } else {
      isNew = true;
      convStatus = fromMe ? "open" : automationActive ? "bot" : "queued";
      const { data: conv } = await db
        .from("conversations")
        .insert({
          organization_id: org,
          channel_id: channel.id,
          contact_id: contact!.id,
          status: convStatus,
          bot_automation_id: automation?.id ?? null,
          last_message_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      conversationId = conv!.id;
    }

    // Mídia: baixa/descriptografa e re-hospeda; áudio ganha transcrição como corpo.
    let mediaUrl = msg.mediaUrl ?? null;
    let body = msg.body ?? null;
    if (MEDIA_TYPES.has(msg.contentType)) {
      const stored = await storeInboundMedia(db, channel as Channel, msg.mediaId ?? msg.externalId, msg.contentType).catch(() => ({}) as { url?: string; transcription?: string });
      if (stored.url) mediaUrl = stored.url;
      if (!body && stored.transcription) body = stored.transcription;
    }

    // Menções em grupo: troca "@<número>" pelo nome do participante.
    if (isGroup && body) {
      const gjid = msg.chatJid || `${msg.from}@g.us`;
      body = await resolveMentions(db, channel as Channel, gjid, body).catch(() => body);
    }

    // Citação: resolve trecho e AUTOR a partir da mensagem citada que já temos no banco
    // (o webhook só traz o LID do autor, sem nome).
    let replyExcerpt = msg.replyTo?.excerpt ?? null;
    let replyAuthor = msg.replyTo?.author ?? null;
    if (msg.replyTo?.externalId) {
      const t = msg.replyTo.externalId;
      const tail = t.includes(":") ? t.split(":").pop()! : t;
      const { data: q } = await db
        .from("messages")
        .select("author_name, direction, body, content_type")
        .or(`external_id.eq.${t},external_id.ilike.%${tail}`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (q) {
        if (!replyExcerpt) replyExcerpt = q.body ?? (q.content_type !== "text" ? `[${q.content_type}]` : null);
        replyAuthor = q.author_name ?? (q.direction === "out" ? "Você" : contact?.name ?? null);
      }
    }

    const { data: insertedMsg } = await db.from("messages").insert({
      organization_id: org,
      conversation_id: conversationId,
      direction: fromMe ? "out" : "in",
      sender_type: fromMe ? "agent" : "contact",
      content_type: msg.contentType,
      body,
      media_url: mediaUrl,
      external_id: msg.externalId ?? null,
      author_name: fromMe ? null : msg.authorName ?? null,
      author_phone: fromMe ? null : msg.authorPhone ?? null,
      author_lid: fromMe ? null : msg.authorLid ?? null,
      reply_to_external: msg.replyTo?.externalId ?? null,
      reply_excerpt: replyExcerpt,
      reply_author: replyAuthor,
      status: fromMe ? "sent" : "delivered",
    }).select("created_at").single();
    const inboundTs = insertedMsg?.created_at ?? null;

    await db
      .from("conversations")
      .update({ last_message_at: new Date().toISOString(), inactivity_warned_at: null })
      .eq("id", conversationId);

    // ====== CSAT: captura nota se aguardando satisfação ======
    if (!fromMe && !isGroup && existing?.status === "closed") {
      const { data: awaitingConv } = await db
        .from("conversations")
        .select("awaiting_satisfaction, survey_id")
        .eq("id", conversationId)
        .maybeSingle();
      if (awaitingConv?.awaiting_satisfaction && body) {
        const note = parseInt(body.trim(), 10);
        if (note >= 1 && note <= 5) {
          await db.from("conversations").update({
            satisfaction: note,
            awaiting_satisfaction: false,
          }).eq("id", conversationId);
          // Mensagem de agradecimento
          const thanks = "Obrigado pela sua avaliação! Ficamos felizes em poder ajudar.";
          const to = isGroup ? `${msg.from}@g.us` : msg.from;
          await getProvider(channel as Channel).sendText({ to, text: thanks }).catch(() => {});
          await db.from("messages").insert({
            organization_id: org, conversation_id: conversationId,
            direction: "out", sender_type: "system", content_type: "text",
            body: thanks, status: "sent",
          });
          continue; // não precisa processar mais nada
        }
      }
    }

    // ====== Mensagens automáticas por evento ======
    if (!fromMe && !isGroup) {
      const autoSend = async (event: string) => {
        const { data: am } = await db.from("auto_messages")
          .select("body").eq("organization_id", org).eq("event", event).eq("active", true)
          .or(`channel_id.eq.${channel.id},channel_id.is.null`)
          .limit(1).maybeSingle();
        if (am?.body) {
          await getProvider(channel as Channel).sendText({ to: msg.from, text: am.body }).catch(() => {});
          await db.from("messages").insert({
            organization_id: org, conversation_id: conversationId,
            direction: "out", sender_type: "system", content_type: "text",
            body: am.body, status: "sent",
          });
        }
        return !!am?.body;
      };

      if (isNew) {
        // Horário de atendimento: checa se estamos fora do horário
        const { data: hours } = await db.from("business_hours")
          .select("day_of_week, start_time, end_time, active")
          .eq("organization_id", org)
          .eq("active", true);
        if (hours && hours.length > 0) {
          const now = new Date(Date.now() + tzOffset * 3600000);
          const dow = now.getUTCDay();
          const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
          const todayHours = hours.filter((h: { day_of_week: number }) => h.day_of_week === dow);
          const inHours = todayHours.some((h: { start_time: string; end_time: string }) => hhmm >= h.start_time && hhmm <= h.end_time);
          if (!inHours) {
            await autoSend("out_of_hours");
          }
        }
        // Boas-vindas (welcome) — só na 1ª msg da conversa
        await autoSend("welcome");
      }

      // Ausência (away) — se o atendente atribuído está offline
      if (existing && convStatus === "open" && existing.status === "open") {
        const { data: assignedConv } = await db.from("conversations")
          .select("assigned_user_id").eq("id", conversationId).maybeSingle();
        if (assignedConv?.assigned_user_id) {
          const { data: agent } = await db.from("profiles")
            .select("status").eq("id", assignedConv.assigned_user_id).maybeSingle();
          if (agent?.status === "offline") {
            await autoSend("away");
          }
        }
      }

      // Fila de espera (queue_wait) — se conversa está em espera
      if (convStatus === "queued") {
        await autoSend("queue_wait");
      }
    }

    // ====== Comando para encerrar (cliente envia palavra-chave) ======
    if (!fromMe && !isGroup && body && (convStatus === "open" || convStatus === "queued")) {
      const closeCmd = String(orgSettings.close_command ?? "").trim();
      if (closeCmd) {
        const keywords = closeCmd.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
        if (keywords.some((k) => body!.toLowerCase().includes(k))) {
          const closeMsg = String(orgSettings.close_command_message ?? "").trim();
          if (closeMsg) {
            await getProvider(channel as Channel).sendText({ to: msg.from, text: closeMsg }).catch(() => {});
            await db.from("messages").insert({
              organization_id: org, conversation_id: conversationId,
              direction: "out", sender_type: "system", content_type: "text",
              body: closeMsg, status: "sent",
            });
          }
          await db.from("conversations").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", conversationId);
          continue;
        }
      }
    }

    // Chatbot: roda só em mensagens recebidas (não nos ecos do próprio número) e
    // apenas quando a automação está dentro do horário configurado.
    if (automationActive && !isGroup && !fromMe && convAiEnabled && (convStatus === "bot" || isNew)) {
      // Buffer de mensagens (debounce): se o contato envia várias mensagens em
      // sequência ("Oi", "Boa tarde"...), espera alguns segundos e processa só a
      // ÚLTIMA. Assim o bot responde uma única vez, com todo o contexto da rajada
      // (a IA lê o histórico completo do banco, então enxerga todas as mensagens).
      const DEBOUNCE_MS = Number(process.env.BOT_DEBOUNCE_MS ?? 8000);
      let botNode = convBotNode;
      if (DEBOUNCE_MS > 0 && inboundTs) {
        await new Promise((res) => setTimeout(res, DEBOUNCE_MS));
        const { data: newer } = await db
          .from("messages")
          .select("id")
          .eq("conversation_id", conversationId)
          .eq("direction", "in")
          .gt("created_at", inboundTs)
          .limit(1)
          .maybeSingle();
        if (newer) continue; // chegou mensagem mais nova: ela processa a rajada
        // Re-checa o estado atual: se um humano assumiu durante a espera, não responde.
        const { data: fresh } = await db
          .from("conversations")
          .select("status, bot_node_id")
          .eq("id", conversationId)
          .maybeSingle();
        if (fresh && fresh.status !== "bot" && !isNew) continue;
        botNode = fresh?.bot_node_id ?? convBotNode;
      }
      // Seção crítica serializada por conversa (ver runExclusive): garante que
      // um turno leia o estado/histórico já consolidados pelo turno anterior.
      await runExclusive(conversationId, async () => {
        // Re-lê o estado DENTRO do lock (pode ter mudado enquanto esperava a vez).
        const { data: cur } = await db
          .from("conversations")
          .select("status, bot_node_id")
          .eq("id", conversationId)
          .maybeSingle();
        if (cur && cur.status !== "bot" && !isNew) return; // humano assumiu

        // Guard anti-duplicação: se o BOT já respondeu depois desta mensagem,
        // outro turno da rajada já a atendeu — não responde de novo (é o que
        // evita a re-saudação e o consultar_cliente em dobro). Só considera
        // sender_type "bot"; auto-mensagens de evento (welcome/away) são "system"
        // e não devem bloquear a saudação inicial em conversas novas.
        if (inboundTs) {
          const { data: answered } = await db
            .from("messages")
            .select("id")
            .eq("conversation_id", conversationId)
            .eq("direction", "out")
            .eq("sender_type", "bot")
            .gt("created_at", inboundTs)
            .limit(1)
            .maybeSingle();
          if (answered) return;
        }

        const r = await runChatbot(
          db,
          channel as Channel,
          { id: conversationId, organization_id: org, channel_id: channel.id, contact_phone: msg.from, contact_name: contact?.name ?? null, is_group: isGroup, bot_node_id: cur?.bot_node_id ?? botNode },
          automation as { id: string; flow: { nodes: never[]; edges: never[] }; integration_id?: string | null },
          body ?? "",
        ).catch((e) => {
          console.warn("chatbot", (e as Error)?.message);
          void logEvent("error", "chatbot", `Falha no chatbot: ${(e as Error)?.message ?? e}`, { conversationId }, org);
          return null;
        });
        if (r === "queued") await db.from("conversations").update({ status: "queued" }).eq("id", conversationId);
      });
    }
  }
}

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 0 };

/** Aplica atualizações de status (entregue/lido) às mensagens enviadas, só "subindo" o nível. */
export async function persistStatusUpdates(updates: { externalId: string; status: "sent" | "delivered" | "read" }[]) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !updates.length) return;
  const db = createServiceClient();
  for (const u of updates) {
    const tail = u.externalId.includes(":") ? u.externalId.split(":").pop()! : u.externalId;
    const { data: msg } = await db
      .from("messages")
      .select("id, status")
      .eq("direction", "out")
      .or(`external_id.eq.${u.externalId},external_id.ilike.%${tail}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!msg) continue;
    if ((STATUS_RANK[u.status] ?? 0) > (STATUS_RANK[msg.status] ?? 0)) {
      await db.from("messages").update({ status: u.status }).eq("id", msg.id);
    }
  }
}

/**
 * Status vindos da Meta, incluindo FALHA com o motivo. Quando a Meta recusa
 * entregar (ex.: mídia que o cliente não consegue baixar), o motivo chega aqui
 * — antes esses eventos eram ignorados e a mensagem ficava "sent" para sempre.
 */
export async function persistMetaStatuses(
  updates: { externalId: string; status: "sent" | "delivered" | "read" | "failed"; errorCode?: number; errorTitle?: string; errorDetails?: string }[],
) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !updates.length) return;
  const db = createServiceClient();
  for (const u of updates) {
    const tail = u.externalId.includes(":") ? u.externalId.split(":").pop()! : u.externalId;
    const { data: msg } = await db
      .from("messages")
      .select("id, status, content_type, organization_id, conversation_id, sender_type, body")
      .eq("direction", "out")
      .or(`external_id.eq.${u.externalId},external_id.ilike.%${tail}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!msg) continue;
    if (u.status === "failed") {
      await db.from("messages").update({ status: "failed" }).eq("id", msg.id);
      void logEvent(
        "error",
        "meta",
        `Meta NÃO entregou (${msg.content_type}): [${u.errorCode ?? "?"}] ${u.errorTitle ?? ""} — ${(u.errorDetails ?? "").slice(0, 200)}`,
        { messageId: msg.id, contentType: msg.content_type, errorCode: u.errorCode, errorTitle: u.errorTitle, errorDetails: u.errorDetails },
        msg.organization_id,
      );
      // FALLBACK ASSÍNCRONO (avisos do SGP/sistema): a Meta ACEITA o envio na
      // hora e só reporta o 131047 (janela de 24h) depois, via webhook — então
      // um fallback síncrono nunca dispara. Quando um aviso do sistema falha
      // por janela, reenviamos automaticamente por um canal uazapi (sem
      // restrição de janela).
      if (u.errorCode === 131047 && msg.sender_type === "system" && msg.content_type === "text" && msg.body) {
        const m = msg as { id: string; organization_id: string; conversation_id: string; body: string };
        // 1º: TEMPLATE pela MESMA linha oficial (o aviso continua saindo pelo
        // número da Central — requisito da operação). Só se o template falhar
        // (ainda não aprovado etc.) cai pro uazapi.
        const viaTemplate = await resendSystemAsTemplate(db, m).catch(() => false);
        if (!viaTemplate) {
          await resendSystemViaUazapi(db, m).catch((e) => console.error("fallback uazapi", e));
        }
      }
      continue;
    }
    if ((STATUS_RANK[u.status] ?? 0) > (STATUS_RANK[msg.status] ?? 0)) {
      await db.from("messages").update({ status: u.status }).eq("id", msg.id);
    }
  }
}

/**
 * Reenvia um aviso de sistema como TEMPLATE (HSM) pela MESMA linha oficial —
 * fora da janela de 24h a Meta só aceita template aprovado, e a operação quer
 * os avisos SEMPRE saindo pelo número da Central. Usa o template
 * `aviso_mvf_sgp` ("Mensagem automática MVF NET…: {{1}}"). Retorna true se
 * conseguiu; false para o chamador cair no fallback uazapi.
 */
async function resendSystemAsTemplate(
  db: ReturnType<typeof createServiceClient>,
  msg: { id: string; organization_id: string; conversation_id: string; body: string },
): Promise<boolean> {
  const { data: conv } = await db.from("conversations").select("contact_id, channel_id").eq("id", msg.conversation_id).maybeSingle();
  if (!conv?.contact_id || !conv?.channel_id) return false;
  const [{ data: contact }, { data: channel }] = await Promise.all([
    db.from("contacts").select("phone, name").eq("id", conv.contact_id).maybeSingle(),
    db.from("channels").select("*").eq("id", conv.channel_id).maybeSingle(),
  ]);
  if (!contact?.phone || !channel || (channel as Channel).type !== "meta_cloud") return false;
  const provider = getProvider(channel as Channel);
  if (!provider.sendTemplate) return false;
  // Parâmetro de template não aceita quebras de linha nem 4+ espaços seguidos.
  const texto = msg.body.replace(/\s+/g, " ").trim().slice(0, 900);
  const nome = (contact.name ?? "").trim().split(/\s+/)[0] || "cliente";
  if (!texto) return false;
  // Tenta em ordem: (1) aviso_mvf_sgp — genérico, carrega o TEXTO REAL do SGP
  // (aguardando aprovação da Meta); (2) o template do Chatmix JÁ APROVADO que
  // CASA com o conteúdo: aviso com LINK de contrato → envio_de_contrato (o
  // link vai no {{1}}); senão → aviso de vencimento (param = nome). Sem isso,
  // um "SMS" de contrato fora da janela viraria um aviso de fatura errado.
  const url = texto.match(/https?:\/\/\S+/)?.[0] ?? null;
  const isContrato = !!url && /contrat|aceite|termo/i.test(texto + url);
  const chatmixTpl = isContrato
    ? {
        name: "envio_de_contrato_chat_7837",
        param: url!,
        render: `Conforme combinado, segue o link para visualização e aceite do seu contrato:\n${url}\n\nQualquer dúvida, fico à disposição.`,
      }
    : {
        name: "aviso_p__s_vencimento_chat_6935",
        param: nome,
        render: `Mensagem automática - MVF NET\nOlá ${nome}, informamos o vencimento da sua fatura. 5 dias após o vencimento a suspensão do serviço de internet é automática pelo sistema.\nSe o pagamento já foi efetuado favor desconsiderar essa mensagem.\nA MVF NET agradece.`,
      };
  const candidatos: { name: string; param: string; render: string }[] = [
    {
      name: "aviso_mvf_sgp",
      param: texto,
      render: `Mensagem automática MVF NET sobre a sua conta:\n\n${texto}\n\nEm caso de dúvida, é só responder esta mensagem.`,
    },
    chatmixTpl,
  ];
  for (const c of candidatos) {
    try {
      const res = await provider.sendTemplate({
        to: contact.phone,
        name: c.name,
        language: "pt_BR",
        components: [{ type: "body", parameters: [{ type: "text", text: c.param }] }],
      });
      await db.from("messages").insert({
        organization_id: msg.organization_id, conversation_id: msg.conversation_id,
        direction: "out", sender_type: "system", content_type: "text",
        body: c.render,
        external_id: res.externalId ?? null, status: "sent",
      });
      await db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", msg.conversation_id);
      void logEvent("info", "sgp-sms", `janela 24h fechada → reenviado como TEMPLATE (${c.name}) pela ${(channel as Channel).name}`, { originalMessageId: msg.id, template: c.name }, msg.organization_id);
      return true;
    } catch (e) {
      void logEvent("warn", "sgp-sms", `template ${c.name} falhou (${(e as Error)?.message?.slice(0, 100)}) — tentando próximo`, { originalMessageId: msg.id }, msg.organization_id);
    }
  }
  return false;
}

/**
 * Reenvia um aviso de sistema (ex.: cobrança do SGP) por um canal uazapi
 * quando a Meta recusou por janela de 24h. Dedup: não reenvia se o MESMO
 * texto já foi mandado ao contato por um canal uazapi nos últimos 10 min.
 */
async function resendSystemViaUazapi(
  db: ReturnType<typeof createServiceClient>,
  msg: { id: string; organization_id: string; conversation_id: string; body: string },
) {
  const { data: conv } = await db.from("conversations").select("contact_id").eq("id", msg.conversation_id).maybeSingle();
  if (!conv?.contact_id) return;
  const { data: contact } = await db.from("contacts").select("id, phone").eq("id", conv.contact_id).maybeSingle();
  if (!contact?.phone) return;

  const { data: fallbacks } = await db
    .from("channels").select("*")
    .eq("organization_id", msg.organization_id).eq("type", "uazapi").eq("status", "connected")
    .limit(3);
  if (!fallbacks?.length) return;

  // Contato pode existir com/sem o 9º dígito — considera as duas formas.
  const p = contact.phone;
  const alt = p.startsWith("55") && p.length === 13 ? p.slice(0, 4) + p.slice(5)
    : p.startsWith("55") && p.length === 12 ? p.slice(0, 4) + "9" + p.slice(4) : null;
  const phones = alt ? [p, alt] : [p];
  const { data: sameContacts } = await db
    .from("contacts").select("id").eq("organization_id", msg.organization_id).in("phone", phones);
  const contactIds = (sameContacts ?? []).map((c: { id: string }) => c.id);

  // Dedup: mesmo texto já reenviado há pouco?
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: recent } = await db
    .from("messages")
    .select("id, conversation_id")
    .eq("organization_id", msg.organization_id)
    .eq("direction", "out").eq("sender_type", "system").eq("body", msg.body)
    .gte("created_at", cutoff)
    .neq("id", msg.id)
    .limit(10);
  if (recent?.length) {
    const convIds = [...new Set(recent.map((r: { conversation_id: string }) => r.conversation_id))];
    const { data: rc } = await db.from("conversations").select("id, channel_id, contact_id").in("id", convIds);
    const { data: chs } = await db.from("channels").select("id, type").eq("type", "uazapi");
    const uazapiIds = new Set((chs ?? []).map((c: { id: string }) => c.id));
    if ((rc ?? []).some((r: { channel_id: string; contact_id: string }) => uazapiIds.has(r.channel_id) && contactIds.includes(r.contact_id))) return;
  }

  for (const ch of fallbacks as Channel[]) {
    try {
      let { data: fconv } = await db
        .from("conversations").select("id")
        .eq("channel_id", ch.id).in("contact_id", contactIds.length ? contactIds : [contact.id])
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!fconv) {
        const { data: created } = await db
          .from("conversations")
          .insert({ organization_id: msg.organization_id, channel_id: ch.id, contact_id: contact.id, status: "closed", ai_enabled: true })
          .select("id").single();
        fconv = created;
      }
      if (!fconv) continue;
      const res = await getProvider(ch).sendText({ to: p, text: msg.body });
      await db.from("messages").insert({
        organization_id: msg.organization_id, conversation_id: fconv.id, direction: "out",
        sender_type: "system", content_type: "text", body: msg.body,
        external_id: res.externalId ?? null, status: "sent",
      });
      await db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", fconv.id);
      void logEvent("info", "sgp-sms", `janela 24h fechada na Meta → reenviado via ${ch.name}`, { originalMessageId: msg.id, channel: ch.name }, msg.organization_id);
      return;
    } catch (e) {
      console.error("resendSystemViaUazapi", ch.name, (e as Error)?.message);
    }
  }
  void logEvent("error", "sgp-sms", "janela 24h fechada e TODOS os fallbacks uazapi falharam", { originalMessageId: msg.id }, msg.organization_id);
}

type Reaction = { emoji: string; by: string };

/** Anexa (ou remove, se emoji vazio) uma reação à mensagem-alvo, casando pelo id externo. */
async function applyReaction(db: DB, targetExternalId: string, emoji: string, by: string) {
  if (!targetExternalId) return;
  const tail = targetExternalId.includes(":") ? targetExternalId.split(":").pop()! : targetExternalId;
  const { data: msg } = await db
    .from("messages")
    .select("id, reactions")
    .or(`external_id.eq.${targetExternalId},external_id.ilike.%${tail}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!msg) return;
  const current: Reaction[] = Array.isArray(msg.reactions) ? (msg.reactions as Reaction[]) : [];
  const without = current.filter((r) => r.by !== by);
  const next = emoji ? [...without, { emoji, by }] : without;
  await db.from("messages").update({ reactions: next }).eq("id", msg.id);
}

type DB = ReturnType<typeof createServiceClient>;
