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
  let query = supabase
    .from("conversation_overview")
    .select("*")
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (!isAdmin && userId) {
    query = query.or(`assigned_user_id.is.null,assigned_user_id.eq.${userId}`);
  }
  const { data } = await query.limit(1000);
  let rows = (data as ConversationOverview[]) ?? [];
  // Grupos não fazem parte do atendimento: novas mensagens de grupo já são
  // descartadas no webhook (inbound.ts); aqui escondemos as que ficaram do
  // período anterior, sem apagar o histórico.
  rows = rows.filter((r) => !r.is_group);
  if (hidden.size) rows = rows.filter((r) => !hidden.has(r.channel_id));
  if (!isAdmin) {
    rows = rows.filter((r) => !r.assigned_user_id || r.assigned_user_id === userId);
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
  const { data } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  return (data as Message[]) ?? [];
}
