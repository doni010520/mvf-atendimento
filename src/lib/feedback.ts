/**
 * Quadro de melhorias e falhas — regras PURAS.
 *
 * Módulo sem I/O de propósito: validação, texto do aviso e agrupamento das
 * colunas são o que decide se a tela mostra a coisa certa, então é o que precisa
 * de teste. Ver feedback.test.ts.
 */

export type TipoFeedback = "falha" | "melhoria";
export type StatusFeedback = "novo" | "analisando" | "resolvendo" | "concluido";

/** A ordem das colunas na tela. É também a ordem do fluxo. */
export const STATUS_FEEDBACK: StatusFeedback[] = ["novo", "analisando", "resolvendo", "concluido"];

export const STATUS_LABEL: Record<StatusFeedback, string> = {
  novo: "Novo",
  analisando: "Analisando",
  resolvendo: "Resolvendo",
  concluido: "Concluído",
};

export const TIPO_LABEL: Record<TipoFeedback, string> = {
  falha: "Falha",
  melhoria: "Melhoria",
};

/** Uma carta do quadro, já pronta para a tela. */
export interface FeedbackItem {
  id: string;
  /** Número do chamado, para a equipe dizer "resolveu o 14?" em vez de descrever o card. */
  numero: number;
  tipo: TipoFeedback;
  status: StatusFeedback;
  titulo: string;
  descricao: string | null;
  printUrl: string | null;
  autor: string | null;
  criadoEm: string;
  statusEm: string;
}

export function ehTipo(v: unknown): v is TipoFeedback {
  return v === "falha" || v === "melhoria";
}

export function ehStatus(v: unknown): v is StatusFeedback {
  return typeof v === "string" && (STATUS_FEEDBACK as string[]).includes(v);
}

/** Limites do que cabe num card. Título curto obriga a resumir, que é o ponto. */
export const MAX_TITULO = 120;
export const MAX_DESCRICAO = 2000;

export type Validado =
  | { ok: true; tipo: TipoFeedback; titulo: string; descricao: string | null }
  | { ok: false; erro: string };

/**
 * Valida o que veio do formulário.
 *
 * Título é o único obrigatório: quanto menos campo exigido, mais gente relata.
 * Descrição vazia vira `null` — string vazia no banco só atrapalha depois.
 * PURA — testada em feedback.test.ts.
 */
export function validarFeedback(entrada: { tipo?: unknown; titulo?: unknown; descricao?: unknown }): Validado {
  const tipo = entrada.tipo;
  if (!ehTipo(tipo)) return { ok: false, erro: "Escolha se é uma falha ou uma melhoria." };

  const titulo = typeof entrada.titulo === "string" ? entrada.titulo.trim() : "";
  if (!titulo) return { ok: false, erro: "Escreva um título — em uma linha, o que aconteceu." };
  if (titulo.length > MAX_TITULO) return { ok: false, erro: `O título passa de ${MAX_TITULO} caracteres. Resuma e conte o resto na descrição.` };

  const descBruta = typeof entrada.descricao === "string" ? entrada.descricao.trim() : "";
  if (descBruta.length > MAX_DESCRICAO) return { ok: false, erro: `A descrição passa de ${MAX_DESCRICAO} caracteres.` };

  return { ok: true, tipo, titulo, descricao: descBruta || null };
}

/**
 * Texto do aviso no grupo, postado só na CRIAÇÃO.
 * PURA — testada em feedback.test.ts.
 */
export function formatFeedbackNovo(p: {
  numero: number;
  tipo: TipoFeedback;
  titulo: string;
  autor?: string | null;
  temPrint?: boolean;
  url: string;
}): string {
  const cara = p.tipo === "falha" ? "🐞" : "💡";
  const rotulo = p.tipo === "falha" ? "Falha relatada" : "Melhoria sugerida";
  const quem = p.autor?.trim() ? ` — ${p.autor.trim()}` : "";
  return [
    `${cara} *${rotulo} #${p.numero}*${quem}`,
    `📋 ${p.titulo.trim()}`,
    p.temPrint ? "📎 com print" : "",
    `➡️ ${p.url}`,
  ].filter(Boolean).join("\n");
}

/**
 * Agrupa as cartas nas quatro colunas.
 *
 * As quatro SEMPRE vêm, mesmo vazias: coluna que some da tela quebra o quadro e
 * tira o lugar de soltar o card arrastado.
 * PURA — testada em feedback.test.ts.
 */
export function agruparPorStatus(itens: FeedbackItem[]): Record<StatusFeedback, FeedbackItem[]> {
  const out = { novo: [], analisando: [], resolvendo: [], concluido: [] } as Record<StatusFeedback, FeedbackItem[]>;
  for (const i of itens) {
    if (ehStatus(i.status)) out[i.status].push(i);
  }
  // Mais recente primeiro — o que acabou de chegar é o que precisa de olho.
  for (const s of STATUS_FEEDBACK) {
    out[s].sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  }
  return out;
}

/**
 * Há quanto tempo a carta está parada nesta coluna: "agora", "há 3 h", "há 5 dias".
 * PURA — testada em feedback.test.ts.
 */
export function tempoParado(statusEm: string, agora: Date = new Date()): string {
  const ms = agora.getTime() - new Date(statusEm).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "agora";
  const min = Math.floor(ms / 60000);
  if (min < 60) return min < 5 ? "agora" : `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "há 1 dia" : `há ${d} dias`;
}
