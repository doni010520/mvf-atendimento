import { createClient } from "@/lib/supabase/server";
import { PREVIEW_MODE } from "@/lib/mock";
import { ehStatus, ehTipo, type FeedbackItem } from "@/lib/feedback";

/**
 * Leitura do quadro de melhorias e falhas.
 *
 * Sem filtro por pessoa de propósito: todo mundo vê tudo, que é o que evita duas
 * atendentes relatarem a mesma falha (mesmo design do correa-atendimento).
 */

/** Quantos dias de "Concluído" a tela mostra. O resto continua no banco. */
export const DIAS_CONCLUIDO = 30;

type Linha = {
  id: string;
  numero: number;
  tipo: string;
  status: string;
  titulo: string;
  descricao: string | null;
  print_url: string | null;
  created_at: string;
  status_em: string;
  profiles: { name: string | null } | { name: string | null }[] | null;
};

function toItem(l: Linha): FeedbackItem | null {
  if (!ehTipo(l.tipo) || !ehStatus(l.status)) return null;
  const p = Array.isArray(l.profiles) ? l.profiles[0] : l.profiles;
  return {
    id: l.id,
    numero: l.numero,
    tipo: l.tipo,
    status: l.status,
    titulo: l.titulo,
    descricao: l.descricao,
    printUrl: l.print_url,
    autor: p?.name?.trim() || null,
    criadoEm: l.created_at,
    statusEm: l.status_em,
  };
}

/**
 * Cartas do quadro. Traz tudo que não está concluído, mais os concluídos
 * recentes — a coluna de concluído cresceria para sempre e deixaria a tela lenta.
 */
export async function listarFeedback(): Promise<FeedbackItem[]> {
  if (PREVIEW_MODE) return [];
  const supabase = await createClient();
  const corte = new Date(Date.now() - DIAS_CONCLUIDO * 86_400_000).toISOString();

  const { data } = await supabase
    .from("feedback_items")
    .select("id, numero, tipo, status, titulo, descricao, print_url, created_at, status_em, profiles:criado_por(name)")
    .or(`status.neq.concluido,status_em.gte.${corte}`)
    .order("created_at", { ascending: false })
    .limit(500);

  return ((data ?? []) as unknown as Linha[]).map(toItem).filter((x): x is FeedbackItem => x !== null);
}
