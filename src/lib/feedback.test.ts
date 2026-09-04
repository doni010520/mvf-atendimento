import { describe, it, expect } from "vitest";
import {
  validarFeedback,
  formatFeedbackNovo,
  agruparPorStatus,
  tempoParado,
  STATUS_FEEDBACK,
  MAX_TITULO,
  type FeedbackItem,
} from "./feedback";

const card = (over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  id: "1",
  numero: 1,
  tipo: "falha",
  status: "novo",
  titulo: "Não consigo anexar foto",
  descricao: null,
  printUrl: null,
  autor: "Maryana Souza",
  criadoEm: "2026-09-01T12:00:00.000Z",
  statusEm: "2026-09-01T12:00:00.000Z",
  ...over,
});

describe("validarFeedback", () => {
  it("aceita o mínimo: tipo e título", () => {
    const r = validarFeedback({ tipo: "falha", titulo: "Tela trava ao encerrar" });
    expect(r).toEqual({ ok: true, tipo: "falha", titulo: "Tela trava ao encerrar", descricao: null });
  });

  it("descrição em branco vira null, não string vazia", () => {
    const r = validarFeedback({ tipo: "melhoria", titulo: "Filtro por data", descricao: "   " });
    expect(r.ok && r.descricao).toBeNull();
  });

  it("título só com espaço é título vazio", () => {
    const r = validarFeedback({ tipo: "falha", titulo: "   " });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/título/i);
  });

  it("recusa tipo que não é falha nem melhoria", () => {
    for (const tipo of ["bug", "", null, undefined, 3]) {
      expect(validarFeedback({ tipo, titulo: "x" }).ok, String(tipo)).toBe(false);
    }
  });

  it("recusa título gigante em vez de cortar calado", () => {
    // Cortar sozinho esconderia metade do relato sem a pessoa perceber.
    const r = validarFeedback({ tipo: "falha", titulo: "a".repeat(MAX_TITULO + 1) });
    expect(r.ok).toBe(false);
  });

  it("apara os espaços do que o usuário digitou", () => {
    const r = validarFeedback({ tipo: "falha", titulo: "  espaços  ", descricao: "  texto  " });
    expect(r.ok && r.titulo).toBe("espaços");
    expect(r.ok && r.descricao).toBe("texto");
  });
});

describe("formatFeedbackNovo", () => {
  const base = { numero: 14, titulo: "Não consigo anexar foto", url: "https://x/melhorias" };

  it("falha e melhoria têm cara diferente no grupo", () => {
    expect(formatFeedbackNovo({ ...base, tipo: "falha" })).toContain("🐞");
    expect(formatFeedbackNovo({ ...base, tipo: "falha" })).toContain("Falha relatada");
    expect(formatFeedbackNovo({ ...base, tipo: "melhoria" })).toContain("💡");
    expect(formatFeedbackNovo({ ...base, tipo: "melhoria" })).toContain("Melhoria sugerida");
  });

  it("a linha do print só aparece quando há print", () => {
    expect(formatFeedbackNovo({ ...base, tipo: "falha", temPrint: true })).toContain("📎");
    expect(formatFeedbackNovo({ ...base, tipo: "falha", temPrint: false })).not.toContain("📎");
  });

  it("sem autor, não sobra um travessão solto", () => {
    const t = formatFeedbackNovo({ ...base, tipo: "falha", autor: "  " });
    expect(t.split("\n")[0]).toBe("🐞 *Falha relatada #14*");
  });

  it("leva o número do chamado, que é como a equipe vai se referir a ele", () => {
    expect(formatFeedbackNovo({ ...base, tipo: "falha" })).toContain("#14");
    expect(formatFeedbackNovo({ ...base, tipo: "melhoria" })).toContain("#14");
  });

  it("leva sempre o link do quadro", () => {
    expect(formatFeedbackNovo({ ...base, tipo: "falha" })).toContain("https://x/melhorias");
  });
});

describe("agruparPorStatus", () => {
  it("as quatro colunas sempre existem, mesmo vazias", () => {
    // Coluna que some tira o lugar de soltar o card arrastado.
    const g = agruparPorStatus([]);
    expect(Object.keys(g).sort()).toEqual([...STATUS_FEEDBACK].sort());
    for (const s of STATUS_FEEDBACK) expect(g[s]).toEqual([]);
  });

  it("separa por status e põe o mais recente primeiro", () => {
    const g = agruparPorStatus([
      card({ id: "a", status: "novo", criadoEm: "2026-09-01T10:00:00.000Z" }),
      card({ id: "b", status: "novo", criadoEm: "2026-09-01T18:00:00.000Z" }),
      card({ id: "c", status: "concluido" }),
    ]);
    expect(g.novo.map((i) => i.id)).toEqual(["b", "a"]);
    expect(g.concluido.map((i) => i.id)).toEqual(["c"]);
    expect(g.analisando).toEqual([]);
  });

  it("status estranho vindo do banco não derruba a tela", () => {
    const g = agruparPorStatus([card({ status: "arquivado" as never })]);
    expect(Object.values(g).every((v) => v.length === 0)).toBe(true);
  });
});

describe("tempoParado", () => {
  const agora = new Date("2026-09-01T12:00:00.000Z");
  const atras = (min: number) => new Date(agora.getTime() - min * 60000).toISOString();

  it("os primeiros minutos são 'agora'", () => {
    expect(tempoParado(atras(0), agora)).toBe("agora");
    expect(tempoParado(atras(4), agora)).toBe("agora");
  });

  it("minutos, horas e dias", () => {
    expect(tempoParado(atras(30), agora)).toBe("há 30 min");
    expect(tempoParado(atras(60 * 3), agora)).toBe("há 3 h");
    expect(tempoParado(atras(60 * 24), agora)).toBe("há 1 dia");
    expect(tempoParado(atras(60 * 24 * 5), agora)).toBe("há 5 dias");
  });

  it("data no futuro ou quebrada não vira texto sem sentido", () => {
    expect(tempoParado(atras(-60), agora)).toBe("agora");
    expect(tempoParado("não é data", agora)).toBe("agora");
  });
});
