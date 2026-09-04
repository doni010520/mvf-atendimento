import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { getProvider } from "@/lib/whatsapp";
import { logEvent } from "@/lib/log";
import type { Channel } from "@/lib/types";

// Ao ficar sem resposta, NÃO encerramos: encaminhamos para um atendente humano
// e avisamos sobre o horário comercial (pedido do cliente).
const DEFAULT_FORWARD =
  "Como não tivemos retorno por aqui, vou encaminhar seu atendimento para um de nossos atendentes. 😊\n\n🕐 Nosso funcionamento é em horário comercial. Se você nos chamou fora desse horário, será atendido assim que começar o expediente.";

/**
 * Envia uma mensagem do bot numa conversa e registra no banco. NÃO mexe em last_message_at.
 * - Canal desconectado: NÃO envia nem registra mensagem fantasma (retorna false).
 * - Envio que falha: registra com status "failed" (não "sent"), para não enganar.
 * Retorna true só quando a mensagem foi de fato aceita pelo provedor.
 */
async function sendBotMessage(
  db: ReturnType<typeof createServiceClient>,
  channelsById: Map<string, Channel>,
  conv: { id: string; organization_id: string; channel_id: string; contact_phone: string; is_group: boolean },
  text: string,
): Promise<boolean> {
  const ch = channelsById.get(conv.channel_id);
  if (!ch) return false;
  // Canal fora do ar → não tem como entregar; não cria mensagem "fantasma".
  if (ch.status !== "connected") return false;

  const to = conv.is_group && ch.type === "uazapi" ? `${conv.contact_phone}@g.us` : conv.contact_phone;
  let externalId: string | undefined;
  let ok = true;
  try {
    const res = await getProvider(ch).sendText({ to, text });
    externalId = res.externalId;
  } catch {
    ok = false;
  }
  await db.from("messages").insert({
    organization_id: conv.organization_id,
    conversation_id: conv.id,
    direction: "out",
    sender_type: "bot",
    content_type: "text",
    body: text,
    external_id: externalId ?? null,
    status: ok ? "sent" : "failed",
  });
  return ok;
}

/**
 * Tarefas periódicas (rodadas pelo cron in-process E pelo endpoint /api/cron):
 * 1. Encerramento por inatividade (avisa → despede → fecha → reseta o fluxo).
 * 2. Transferência automática por inatividade.
 */
export async function runCronJobs(): Promise<{ closed: number; warned: number; transferred: number }> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { closed: 0, warned: 0, transferred: 0 };

  const db = createServiceClient();
  const now = new Date();
  let closedCount = 0;
  let warnedCount = 0;
  let transferredCount = 0;

  const { data: orgs } = await db.from("organizations").select("id, settings");

  for (const org of orgs ?? []) {
    const s = (org.settings ?? {}) as Record<string, unknown>;
    const transferCompanyMin = Number(s.auto_transfer_company_min) || 0;
    const transferDeptId = String(s.auto_transfer_dept_id ?? "");

    // ── Inatividade: sem resposta do cliente → NÃO encerra. Encaminha para um
    //    atendente humano (fila) e avisa sobre o horário comercial. (padrão 15min) ──
    const inactivityEnabled = s.inactivity_enabled !== false;
    const closeMin = s.inactivity_close_min != null ? Number(s.inactivity_close_min) : 15;
    const forwardMsg = String(s.inactivity_goodbye_message || DEFAULT_FORWARD);

    if (inactivityEnabled && closeMin > 0) {
      const { data: chans } = await db.from("channels").select("*").eq("organization_id", org.id);
      const channelsById = new Map<string, Channel>(((chans ?? []) as Channel[]).map((c) => [c.id, c]));
      // Só age em conversas AINDA no bot (cliente sumiu no meio do atendimento
      // automático). Se já tem humano (open) ou está na fila (queued), não mexe.
      const closeThreshold = new Date(now.getTime() - closeMin * 60000).toISOString();
      const sel = "id, organization_id, channel_id, status, contacts(phone, is_group)";
      type Row = {
        id: string; organization_id: string; channel_id: string; status: string;
        contacts: { phone: string; is_group: boolean } | { phone: string; is_group: boolean }[] | null;
      };
      const shape = (c: Row) => {
        const ct = Array.isArray(c.contacts) ? c.contacts[0] : c.contacts;
        return { id: c.id, organization_id: c.organization_id, channel_id: c.channel_id, contact_phone: ct?.phone ?? "", is_group: !!ct?.is_group };
      };

      // ENCAMINHAR: ocioso há >= closeMin no bot → avisa e passa para a fila humana
      // (IA desligada, sem encerrar). Um atendente assume no expediente.
      // `assigned_user_id is null`: reforço de segurança — uma conversa com
      // atendente responsável NUNCA deveria estar "bot", mas se algum bug
      // (ex.: a corrida corrigida em 04/09 — cliente escreve, atendente assume
      // dentro do debounce, IA responde do mesmo jeito e reseta o status)
      // deixar essa inconsistência, esta rotina não vai "resgatar" e mandar a
      // mensagem de encerramento por cima de um atendimento que já tem dono.
      const { data: toForward } = await db
        .from("conversations")
        .select(sel)
        .eq("organization_id", org.id)
        .eq("status", "bot")
        .is("assigned_user_id", null)
        .lt("last_message_at", closeThreshold)
        .limit(200);
      for (const c of (toForward ?? []) as Row[]) {
        const conv = shape(c);
        if (conv.contact_phone) await sendBotMessage(db, channelsById, conv, forwardMsg);
        await db.from("conversations")
          .update({ status: "queued", ai_enabled: false, bot_node_id: null, inactivity_warned_at: null })
          .eq("id", c.id);
        // Nota interna para o atendente saber o contexto.
        await db.from("messages").insert({
          organization_id: org.id, conversation_id: c.id,
          direction: "out", sender_type: "system", content_type: "text",
          body: "Encaminhado para atendimento humano por falta de resposta do cliente (inatividade).",
          is_internal: true, status: "sent",
        }).then(() => {}, () => {});
        closedCount++;
      }
    }

    // ── Transferência automática ──
    if (transferCompanyMin > 0 && transferDeptId) {
      const threshold = new Date(now.getTime() - transferCompanyMin * 60000).toISOString();
      const { data: stale } = await db
        .from("conversations")
        .select("id")
        .eq("organization_id", org.id)
        .eq("status", "open")
        .lt("last_message_at", threshold)
        .limit(200);
      if (stale?.length) {
        const ids = stale.map((c: { id: string }) => c.id);
        await db.from("conversations")
          .update({ department_id: transferDeptId, assigned_user_id: null, status: "queued" })
          .in("id", ids);
        transferredCount += ids.length;
      }
    }
  }

  // Só registra log quando algo aconteceu (evita poluir os Eventos recentes).
  if (closedCount || warnedCount || transferredCount) {
    void logEvent("info", "cron", `Inatividade: ${closedCount} encerrada(s), ${warnedCount} avisada(s), ${transferredCount} transferida(s).`);
  }

  return { closed: closedCount, warned: warnedCount, transferred: transferredCount };
}
