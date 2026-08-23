import "server-only";
import webpush from "web-push";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/log";
import { getVapid, listSubscriptions, removeSubscription } from "./store";

/**
 * Disparo de notificação push para os atendentes.
 *
 * REGRA: nada aqui pode derrubar o fluxo que chamou. Isto roda dentro do
 * webhook do WhatsApp — se o push falhar, a mensagem do cliente TEM que ser
 * gravada do mesmo jeito. Por isso toda função engole o próprio erro e o
 * registro fica em `app_logs` (source "push").
 */

type DB = ReturnType<typeof createServiceClient>;

export type PushPayload = {
  title: string;
  body: string;
  /** Para onde o clique leva. Default: /atendimento */
  url?: string;
  /** Agrupa notificações da mesma conversa (não empilha 10 avisos). */
  tag?: string;
};

/** Envia para todos os aparelhos dos usuários indicados. Nunca lança. */
export async function sendPushToUsers(
  db: DB,
  orgId: string,
  userIds: string[],
  payload: PushPayload,
): Promise<{ sent: number; dropped: number }> {
  let sent = 0;
  let dropped = 0;
  try {
    if (!orgId || userIds.length === 0) return { sent, dropped };

    const subs = await listSubscriptions(db, orgId, userIds);
    if (subs.length === 0) return { sent, dropped };

    const vapid = await getVapid(db, orgId);
    if (!vapid) return { sent, dropped };
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? "/atendimento",
      tag: payload.tag,
    });

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            // TTL curto: aviso de atendimento que chega 1h depois só atrapalha.
            { TTL: 600, urgency: "high" },
          );
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410 = inscrição morta (app desinstalado, permissão revogada).
          // Limpa em vez de tentar para sempre.
          if (status === 404 || status === 410) {
            dropped++;
            await removeSubscription(db, orgId, s.endpoint).catch(() => {});
          } else {
            void logEvent(
              "warn",
              "push",
              `Falha ao enviar push (${status ?? "sem status"})`,
              { endpoint: s.endpoint.slice(0, 60), status },
              orgId,
            );
          }
        }
      }),
    );
  } catch (err) {
    void logEvent("error", "push", "Erro inesperado no disparo de push", {
      error: String((err as Error)?.message ?? err),
    });
  }
  return { sent, dropped };
}

/* ------------------------------------------------------------------ *
 * Regra de quem recebe o quê
 * ------------------------------------------------------------------ */

/** Anti-rajada: mesma conversa não vibra o aparelho a cada mensagem seguida. */
const lastPush = new Map<string, number>();
const BURST_MS = 15_000;

function throttled(key: string): boolean {
  const now = Date.now();
  const prev = lastPush.get(key) ?? 0;
  if (now - prev < BURST_MS) return true;
  lastPush.set(key, now);
  // Poda simples pra memória não crescer indefinidamente no container.
  if (lastPush.size > 5000) {
    for (const [k, t] of lastPush) if (now - t > 5 * BURST_MS) lastPush.delete(k);
  }
  return false;
}

function previewOf(contentType: string, body: string | null): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  switch (contentType) {
    case "image":
      return "📷 Foto";
    case "video":
      return "🎥 Vídeo";
    case "audio":
      return "🎤 Áudio";
    case "document":
      return "📄 Documento";
    case "sticker":
      return "Figurinha";
    case "location":
      return "📍 Localização";
    case "contact":
      return "👤 Contato";
    default:
      return "Nova mensagem";
  }
}

/**
 * Mensagem recebida do cliente → avisa quem precisa agir:
 *
 *  - conversa COM dono ....... só o dono (ninguém mais é notificado);
 *  - conversa na FILA ........ todos os atendentes com `notify` ligado;
 *  - conversa com o BOT ...... ninguém (a IA está atendendo; avisar seria ruído
 *                              constante no celular de todo mundo).
 */
export async function notifyInboundMessage(args: {
  db: DB;
  orgId: string;
  conversationId: string;
  contactName: string;
  contentType: string;
  body: string | null;
}): Promise<void> {
  try {
    const { db, orgId, conversationId } = args;
    if (!orgId || !conversationId) return;

    const { data: conv } = await db
      .from("conversations")
      .select("assigned_user_id, status, ai_enabled")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conv) return;
    if (conv.status === "closed") return;

    let userIds: string[] = [];
    if (conv.assigned_user_id) {
      userIds = [conv.assigned_user_id as string];
    } else {
      // Bot cuidando: silêncio.
      if (conv.status === "bot" && conv.ai_enabled !== false) return;
      const { data: people } = await db
        .from("profiles")
        .select("id")
        .eq("organization_id", orgId)
        .eq("notify", true);
      userIds = (people ?? []).map((p: { id: string }) => p.id);
    }
    if (userIds.length === 0) return;

    const alvo = userIds.filter((id) => !throttled(`${conversationId}:${id}`));
    if (alvo.length === 0) return;

    await sendPushToUsers(db, orgId, alvo, {
      title: args.contactName || "Nova mensagem",
      body: previewOf(args.contentType, args.body),
      url: `/atendimento?c=${conversationId}`,
      tag: conversationId,
    });
  } catch {
    /* push nunca derruba o webhook */
  }
}

/** Menção a um atendente numa nota interna → avisa só ele. */
export async function notifyMention(args: {
  db: DB;
  orgId: string;
  userIds: string[];
  conversationId: string;
  authorName: string;
  body: string | null;
}): Promise<void> {
  try {
    if (args.userIds.length === 0) return;
    await sendPushToUsers(args.db, args.orgId, args.userIds, {
      title: `${args.authorName} mencionou você`,
      body: previewOf("text", args.body),
      url: `/atendimento?c=${args.conversationId}`,
      tag: `mention:${args.conversationId}`,
    });
  } catch {
    /* idem */
  }
}
