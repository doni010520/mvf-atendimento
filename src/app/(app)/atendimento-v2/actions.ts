"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth";
import { logEvent } from "@/lib/log";
import type { ConversationOverview } from "@/lib/types";

/**
 * Move uma conversa entre as colunas do board (drag-drop):
 * - "open"  → assume p/ o atendente atual e pausa a IA;
 * - "queued"→ devolve à fila (sem atendente);
 * - "bot"   → devolve para a automação (reativa IA).
 */
export async function moveConversationStatus(id: string, status: "open" | "queued" | "bot") {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return { ok: false };
  const session = await getSession();
  if (!session?.organization) throw new Error("Sessão inválida.");
  const sb = await createClient();

  const patch: Record<string, unknown> = { status };
  if (status === "open") {
    patch.ai_enabled = false;
    patch.assigned_user_id = session.userId;
  } else if (status === "queued") {
    patch.ai_enabled = false;
    patch.assigned_user_id = null;
  } else if (status === "bot") {
    patch.ai_enabled = true;
    patch.bot_node_id = null;
  }

  const { error } = await sb.from("conversations").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
  const label = status === "open" ? "assumiu (moveu p/ Em andamento, IA pausada)"
    : status === "queued" ? "moveu p/ Em espera (IA pausada)"
    : "devolveu para a IA";
  void logEvent("info", "atendente", `${session.profile?.name ?? "Atendente"} ${label} [V2]`, { conversationId: id, userId: session.userId, action: "mover", status }, session.organization.id);

  // Mensagem visível no chat (histórico de ativação/desativação da IA, com nome).
  const quem = session.profile?.name ? ` por ${session.profile.name}` : "";
  const nota = status === "bot" ? `Atendimento devolvido para a IA${quem}.`
    : status === "queued" ? `Atendimento devolvido à fila${quem} (IA pausada).`
    : `IA pausada — atendimento assumido${quem}.`;
  await sb.from("messages").insert({
    organization_id: session.organization.id,
    conversation_id: id,
    direction: "out",
    sender_type: "system",
    content_type: "text",
    body: nota,
    is_internal: true,
    status: "sent",
  }).then(() => {}, () => {});
  revalidatePath("/atendimento-v2");
  return { ok: true };
}

export type BuscaEncerradosResultado =
  | { ok: true; itens: ConversationOverview[] }
  | { ok: false; erro: string };

/**
 * Busca atendimentos ENCERRADOS por telefone num período — direto no banco,
 * sem o teto de 500 (ativas) / 150 (encerradas) que a listagem padrão usa
 * (getConversations). Esse teto existe pra tela do dia a dia não ficar
 * pesada, mas ele corta o histórico: um atendimento de agosto some da lista
 * se já houver 150 encerramentos mais recentes — e o atendente que só lembra
 * "foi em algum dia de agosto" não tem como encontrar rolando a tela.
 *
 * Telefone é OBRIGATÓRIO: sem ele a busca varreria a organização inteira por
 * um período largo, o que é lento e não é o caso de uso (a pessoa sempre sabe
 * de qual cliente é o atendimento, só não lembra o dia exato).
 */
export async function buscarEncerradosPorPeriodo(params: {
  telefone: string;
  dataInicio: string; // "YYYY-MM-DD"
  dataFim: string; // "YYYY-MM-DD"
}): Promise<BuscaEncerradosResultado> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return { ok: true, itens: [] };
  const session = await getSession();
  if (!session?.organization) return { ok: false, erro: "Sessão expirada. Recarregue a página." };

  const telefone = params.telefone.replace(/\D/g, "");
  if (!telefone) return { ok: false, erro: "Informe o telefone do cliente." };
  if (!params.dataInicio || !params.dataFim) return { ok: false, erro: "Informe a data inicial e a data final." };
  if (params.dataInicio > params.dataFim) return { ok: false, erro: "A data inicial não pode ser depois da data final." };

  const sb = await createClient();
  // ENCERRADA é histórico visível a todo atendente (mesma regra de
  // getConversations em lib/data/conversations.ts) — sem filtro extra de dono.
  const { data, error } = await sb
    .from("conversation_overview")
    .select("*")
    .eq("organization_id", session.organization.id)
    .eq("status", "closed")
    .like("contact_phone", `%${telefone}%`)
    .gte("closed_at", `${params.dataInicio}T00:00:00`)
    .lte("closed_at", `${params.dataFim}T23:59:59.999`)
    .order("closed_at", { ascending: false })
    .limit(200);

  if (error) return { ok: false, erro: "Não foi possível buscar agora. Tente de novo em instantes." };
  return { ok: true, itens: (data as ConversationOverview[]) ?? [] };
}
