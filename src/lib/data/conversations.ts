import { unstable_noStore as noStore } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { MOCK_CONVERSATIONS, MOCK_MESSAGES, PREVIEW_MODE } from "@/lib/mock";
import type { ConversationOverview, Message } from "@/lib/types";

export async function getConversations(): Promise<ConversationOverview[]> {
  if (PREVIEW_MODE) return MOCK_CONVERSATIONS;
  noStore(); // sempre dados frescos (polling da inbox)

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? null;

  // Papel do usuário: admin (ou dono) vê tudo; ATENDENTE vê só as conversas
  // NÃO ATRIBUÍDAS (fila/bot) + as atribuídas a ELE. Nunca as de outro atendente.
  let isAdmin = false;
  if (userId) {
    const { data: me } = await supabase.from("profiles").select("role, super_admin").eq("id", userId).maybeSingle();
    const p = me as { role?: string; super_admin?: boolean } | null;
    isAdmin = p?.role === "admin" || p?.super_admin === true;
  }

  // Canais PRIVADOS: um canal com credentials.private_owner só aparece para esse
  // usuário (as conversas dele ficam ocultas para todos os demais).
  const { data: chans } = await supabase.from("channels").select("id, credentials");
  const hidden = new Set<string>();
  for (const c of (chans ?? []) as { id: string; credentials: Record<string, unknown> | null }[]) {
    const owner = c.credentials?.private_owner as string | undefined;
    if (owner && owner !== userId) hidden.add(c.id);
  }

  // Filtro de visibilidade aplicado JÁ NO SQL (antes do limite): atendente
  // não-admin só vê as SEM dono (fila/bot) + as dele. Isso é importante para o
  // teto não cortar as conversas ANTIGAS do próprio atendente (o limite antes
  // era global e escondia as dele). O teto alto é só trava de crescimento — com
  // os índices parciais a view é barata.
  // Duas consultas em vez de um teto único: as ATIVAS (bot/fila/abertas) vêm
  // TODAS — são poucas e nenhuma pode sumir da tela —, e só as ENCERRADAS
  // levam teto (é histórico, cresce sem parar). Um limite global cortava
  // conversas ativas antigas ("não consigo ver conversas anteriores").
  const withVisibility = <T extends { or: (f: string) => T }>(q: T): T =>
    !isAdmin && userId ? q.or(`assigned_user_id.is.null,assigned_user_id.eq.${userId}`) : q;

  const base = () =>
    supabase.from("conversation_overview").select("*").order("last_message_at", { ascending: false, nullsFirst: false });

  // ENCERRADA é HISTÓRICO: visível para TODO atendente (o painel do contato tem
  // "Atendimentos anteriores → Ver conversa", que precisa abrir para quem está
  // atendendo agora, não só para admin). O filtro de visibilidade vale só para
  // as ATIVAS — é lá que um atendente não deve mexer no atendimento do outro.
  const [ativas, encerradas] = await Promise.all([
    // Teto voltou pra 500 (era 2000): v2.40.88 subiu isso pra resolver
    // "conversas ativas cortadas", mas reabriu o gargalo de perf que o
    // v2.40.81 tinha acabado de fechar (view com 2 lateral joins por linha,
    // poll a cada 10s por atendente). 500 já é a faixa que os índices de
    // 0025_perf_indexes.sql foram desenhados pra aguentar sem timeout.
    withVisibility(base().neq("status", "closed")).limit(500),
    base().eq("status", "closed").limit(150),
  ]);
  let rows = [
    ...((ativas.data as ConversationOverview[]) ?? []),
    ...((encerradas.data as ConversationOverview[]) ?? []),
  ].sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  // Grupos não fazem parte do atendimento: novas mensagens de grupo já são
  // descartadas no webhook (inbound.ts); aqui escondemos as que ficaram do
  // período anterior, sem apagar o histórico.
  rows = rows.filter((r) => !r.is_group);
  if (hidden.size) rows = rows.filter((r) => !hidden.has(r.channel_id));
  if (!isAdmin) {
    rows = rows.filter((r) => {
      if (r.status === "closed") return true; // histórico: visível p/ todos
      if (r.assigned_user_id === userId) return true; // é minha
      if (r.assigned_user_id) return false; // de outro atendente
      // Sem dono: fila geral (offered_to vazio) OU oferecida especificamente a mim.
      const off = r.offered_to;
      return !off || off.length === 0 || (userId != null && off.includes(userId));
    });
  }
  return rows;
}

/** Mapa conversa → lista de tag_ids (para filtros do board). */
export async function getConversationTagMap(): Promise<Record<string, string[]>> {
  if (PREVIEW_MODE) return {};
  noStore();
  const supabase = await createClient();
  const { data } = await supabase.from("conversation_tags").select("conversation_id, tag_id");
  const map: Record<string, string[]> = {};
  for (const row of (data as { conversation_id: string; tag_id: string }[]) ?? []) {
    (map[row.conversation_id] ??= []).push(row.tag_id);
  }
  return map;
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  if (PREVIEW_MODE) return MOCK_MESSAGES[conversationId] ?? [];
  noStore(); // sempre dados frescos (polling da inbox)

  const supabase = await createClient();
  // HISTÓRICO COMPLETO do contato: cada atendimento é uma conversa NOVA
  // (o inbound cria outra quando a anterior está encerrada), então limitar o
  // thread à conversa atual escondia todo o passado do cliente — o atendente
  // abria a conversa atribuída a ele e ela começava "do zero". Mesclamos as
  // mensagens de TODAS as conversas do mesmo contato+canal, em ordem
  // cronológica (últimas 600 — o teto implícito do PostgREST é 1000).
  const { data: conv } = await supabase
    .from("conversations")
    .select("contact_id, channel_id")
    .eq("id", conversationId)
    .maybeSingle();
  let ids: string[] = [conversationId];
  if (conv?.contact_id && conv?.channel_id) {
    const { data: siblings } = await supabase
      .from("conversations")
      .select("id")
      .eq("contact_id", conv.contact_id)
      .eq("channel_id", conv.channel_id);
    if (siblings?.length) ids = siblings.map((s) => s.id);
  }
  const { data } = await supabase
    .from("messages")
    .select("*")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .limit(600);
  return (((data as Message[]) ?? []) as Message[]).reverse();
}
