"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bug, Lightbulb, Paperclip, Plus, X } from "lucide-react";
import {
  agruparPorStatus,
  tempoParado,
  STATUS_FEEDBACK,
  STATUS_LABEL,
  TIPO_LABEL,
  type FeedbackItem,
  type StatusFeedback,
  type TipoFeedback,
} from "@/lib/feedback";
import { criarFeedback, moverFeedback } from "@/app/(app)/melhorias/actions";

/**
 * Quadro de melhorias e falhas.
 *
 * DUAS formas de mover, de propósito: arrastar (desktop) e um seletor dentro do
 * card. O kanban de conversas usa só `draggable` do HTML5, que NÃO funciona em
 * toque — e quem relata problema costuma estar no celular, com o print na mão.
 * O arrastar é atalho; o seletor é o caminho que sempre funciona.
 */

const COR_COLUNA: Record<StatusFeedback, string> = {
  novo: "bg-danger",
  analisando: "bg-warning",
  resolvendo: "bg-brand",
  concluido: "bg-success",
};

function Etiqueta({ tipo }: { tipo: TipoFeedback }) {
  const falha = tipo === "falha";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide ${
        falha ? "bg-danger/12 text-danger" : "bg-brand/12 text-brand"
      }`}
    >
      {falha ? <Bug size={11} /> : <Lightbulb size={11} />}
      {TIPO_LABEL[tipo]}
    </span>
  );
}

function Card({
  item,
  onMover,
  onAbrir,
  ocupado,
}: {
  item: FeedbackItem;
  onMover: (id: string, s: StatusFeedback) => void;
  onAbrir: (i: FeedbackItem) => void;
  ocupado: boolean;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/id", item.id)}
      className="cursor-grab rounded-lg border border-border bg-surface p-3 shadow-card active:cursor-grabbing"
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Etiqueta tipo={item.tipo} />
          <span className="font-mono text-[0.68rem] tabular-nums text-ink-soft">#{item.numero}</span>
        </div>
        {item.printUrl && <Paperclip size={13} className="mt-0.5 shrink-0 text-ink-soft" />}
      </div>

      <button onClick={() => onAbrir(item)} className="block w-full text-left">
        <p className="text-sm font-medium leading-snug text-ink">{item.titulo}</p>
      </button>

      <p className="mt-1.5 text-[0.7rem] text-ink-soft">
        {item.autor ?? "—"} · {tempoParado(item.statusEm)}
      </p>

      {/* O seletor é o que faz o quadro funcionar no celular. */}
      <select
        value={item.status}
        disabled={ocupado}
        onChange={(e) => onMover(item.id, e.target.value as StatusFeedback)}
        className="mt-2 w-full rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink disabled:opacity-50"
        aria-label={`Mover "${item.titulo}"`}
      >
        {STATUS_FEEDBACK.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
    </div>
  );
}

function Formulario({ onFechar }: { onFechar: () => void }) {
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Trava SÍNCRONA contra duplo-clique. O `disabled` do botão depende de um
  // re-render, e em 01/09 dois cliques rápidos passaram antes dele: o mesmo
  // relato virou os chamados #2 e #3, com 2,1 s de diferença e dois prints.
  // Um ref é lido e escrito na hora, sem esperar o React.
  const enviandoRef = useRef(false);
  const router = useRouter();

  async function enviar(fd: FormData) {
    if (enviandoRef.current) return;
    enviandoRef.current = true;
    setEnviando(true);
    setErro(null);
    const r = await criarFeedback(fd);
    setEnviando(false);
    // Erro NÃO fecha o modal: o que a pessoa escreveu continua na tela — e
    // libera a trava, senão a pessoa não consegue tentar de novo.
    if (!r.ok) {
      enviandoRef.current = false;
      return setErro(r.erro);
    }
    onFechar();
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-pop sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">Relatar</h2>
          <button onClick={onFechar} className="rounded p-1 text-ink-soft hover:bg-canvas" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <form action={enviar} className="flex flex-col gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-soft">O que é?</label>
            <div className="grid grid-cols-2 gap-2">
              {(["falha", "melhoria"] as TipoFeedback[]).map((t, i) => (
                <label
                  key={t}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-ink has-[:checked]:border-brand has-[:checked]:bg-brand-light"
                >
                  <input type="radio" name="tipo" value={t} defaultChecked={i === 0} className="accent-brand" />
                  {t === "falha" ? "Algo com problema" : "Ideia de melhoria"}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-soft">Em uma linha, o que houve?</label>
            <input
              name="titulo"
              autoFocus
              maxLength={120}
              placeholder="Ex.: não consigo anexar foto no orçamento"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-soft">Quer contar mais? (opcional)</label>
            <textarea
              name="descricao"
              rows={4}
              maxLength={2000}
              placeholder="Onde aconteceu, o que você estava fazendo, o que esperava que acontecesse."
              className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-soft">Print da tela (opcional)</label>
            <input
              type="file"
              name="print"
              accept="image/*"
              className="w-full text-xs text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-canvas file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-ink"
            />
            <p className="mt-1 text-[0.7rem] text-ink-soft">Ajuda muito num problema — até 8 MB.</p>
          </div>

          {erro && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{erro}</p>}

          <button
            type="submit"
            disabled={enviando}
            className="mt-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {enviando ? "Enviando…" : "Enviar"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Detalhe({ item, onFechar }: { item: FeedbackItem; onFechar: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onFechar}>
      <div
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-pop sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Etiqueta tipo={item.tipo} />
              <span className="font-mono text-xs tabular-nums text-ink-soft">#{item.numero}</span>
            </div>
            <h2 className="text-lg font-bold leading-snug text-ink">{item.titulo}</h2>
          </div>
          <button onClick={onFechar} className="rounded p-1 text-ink-soft hover:bg-canvas" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <p className="mb-4 text-xs text-ink-soft">
          {item.autor ?? "—"} · {STATUS_LABEL[item.status]} {tempoParado(item.statusEm)}
        </p>

        {item.descricao && <p className="mb-4 whitespace-pre-wrap text-sm leading-relaxed text-ink">{item.descricao}</p>}

        {item.printUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.printUrl} alt="Print enviado no relato" className="w-full rounded-lg border border-border" />
        )}
      </div>
    </div>
  );
}

export function FeedbackBoard({ itens }: { itens: FeedbackItem[] }) {
  const [form, setForm] = useState(false);
  const [aberto, setAberto] = useState<FeedbackItem | null>(null);
  const [arrastando, setArrastando] = useState<StatusFeedback | null>(null);
  const [pendente, startTransition] = useTransition();
  const router = useRouter();

  const colunas = agruparPorStatus(itens);

  const mover = (id: string, status: StatusFeedback) => {
    startTransition(async () => {
      await moverFeedback(id, status);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Melhorias e falhas</h1>
          <p className="mt-0.5 text-sm text-ink-soft">
            Achou um problema ou teve uma ideia? Registra aqui que não se perde.
          </p>
        </div>
        <button
          onClick={() => setForm(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
        >
          <Plus size={16} /> Relatar
        </button>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {STATUS_FEEDBACK.map((s) => (
          <section
            key={s}
            onDragOver={(e) => {
              e.preventDefault();
              setArrastando(s);
            }}
            onDragLeave={() => setArrastando((x) => (x === s ? null : x))}
            onDrop={(e) => {
              e.preventDefault();
              setArrastando(null);
              const id = e.dataTransfer.getData("text/id");
              if (id) mover(id, s);
            }}
            className={`flex flex-col gap-2 rounded-card border bg-canvas p-3 ${
              arrastando === s ? "border-brand ring-2 ring-brand/30" : "border-border"
            }`}
          >
            <div className="flex items-center gap-2 px-0.5">
              <span className={`h-2 w-2 rounded-full ${COR_COLUNA[s]}`} />
              <h2 className="text-[0.72rem] font-bold uppercase tracking-[0.12em] text-ink-soft">{STATUS_LABEL[s]}</h2>
              <span className="ml-auto font-mono text-xs tabular-nums text-ink-soft">{colunas[s].length}</span>
            </div>

            {colunas[s].length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-ink-soft/70">vazio</p>
            ) : (
              colunas[s].map((i) => (
                <Card key={i.id} item={i} onMover={mover} onAbrir={setAberto} ocupado={pendente} />
              ))
            )}
          </section>
        ))}
      </div>

      <p className="text-xs text-ink-soft">
        Concluído mostra os últimos 30 dias. Qualquer pessoa pode registrar e mover.
      </p>

      {form && <Formulario onFechar={() => setForm(false)} />}
      {aberto && <Detalhe item={aberto} onFechar={() => setAberto(null)} />}
    </div>
  );
}
