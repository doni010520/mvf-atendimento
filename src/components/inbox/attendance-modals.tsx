"use client";

import { useState } from "react";
import { X, CheckCircle2, ArrowRightLeft, Send, Check } from "lucide-react";
import type { Tag, Profile, Department } from "@/lib/types";

function Overlay({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand";

// ---------------------------------------------------------------------------
// Encerrar atendimento — classificação + motivo + pesquisa opcional
// ---------------------------------------------------------------------------
export function CloseModal({
  tags,
  protocol,
  onConfirm,
  onCancel,
  pending,
}: {
  tags: Tag[];
  protocol: string | null;
  onConfirm: (opts: { reason: string; solution: string; forwardings: string; pending: string; tagIds: string[]; sendSurvey: boolean }) => void;
  onCancel: () => void;
  pending?: boolean;
}) {
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [solution, setSolution] = useState("");
  const [forwardings, setForwardings] = useState("");
  const [pendencias, setPendencias] = useState("");
  const [sendSurvey, setSendSurvey] = useState(false);

  function toggle(id: string) {
    setTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  return (
    <Overlay onCancel={onCancel}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
          <CheckCircle2 size={18} className="text-danger" /> Encerrar atendimento
        </h2>
        <button onClick={onCancel} className="text-ink-soft hover:text-ink">
          <X size={18} />
        </button>
      </div>

      {protocol && <p className="mb-3 text-xs text-ink-soft">Protocolo {protocol}</p>}

      <label className="mb-1.5 block text-xs font-medium text-ink-soft">Classificação</label>
      {tags.length === 0 ? (
        <p className="mb-3 text-xs text-ink-soft">
          Nenhuma classificação cadastrada. Crie em Ajustes › Classificações.
        </p>
      ) : (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {tags.map((t) => {
            const on = tagIds.includes(t.id);
            return (
              <button
                key={t.id}
                onClick={() => toggle(t.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  on ? "text-white" : "text-ink hover:bg-gray-100"
                }`}
                style={on ? { backgroundColor: t.color ?? "#00a8ff" } : { backgroundColor: "#f1f3f5" }}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      )}

      <p className="mb-2 text-[11px] text-ink-soft">
        Registre o atendimento para que qualquer atendente dê continuidade depois — sem o cliente repetir tudo.
      </p>

      <label className="mb-1.5 block text-xs font-medium text-ink-soft">Motivo do atendimento</label>
      <textarea
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="Por que o cliente entrou em contato?"
        className={`mb-3 resize-none ${inputCls}`}
      />

      <label className="mb-1.5 block text-xs font-medium text-ink-soft">Solução apresentada</label>
      <textarea
        value={solution}
        onChange={(e) => setSolution(e.target.value)}
        rows={2}
        placeholder="O que foi feito / orientado para resolver."
        className={`mb-3 resize-none ${inputCls}`}
      />

      <label className="mb-1.5 block text-xs font-medium text-ink-soft">Encaminhamentos realizados</label>
      <textarea
        value={forwardings}
        onChange={(e) => setForwardings(e.target.value)}
        rows={2}
        placeholder="Ex.: aberto chamado técnico, transferido ao financeiro…"
        className={`mb-3 resize-none ${inputCls}`}
      />

      <label className="mb-1.5 block text-xs font-medium text-ink-soft">
        Pendências <span className="font-normal text-ink-soft/70">(se houver)</span>
      </label>
      <textarea
        value={pendencias}
        onChange={(e) => setPendencias(e.target.value)}
        rows={2}
        placeholder="O que ficou em aberto para o próximo atendimento."
        className={`mb-3 resize-none ${inputCls} border-amber-300 focus:border-amber-400`}
      />

      <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={sendSurvey}
          onChange={(e) => setSendSurvey(e.target.checked)}
          className="h-4 w-4 accent-brand"
        />
        Enviar pesquisa de satisfação ao cliente
      </label>

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-ink hover:bg-gray-200"
        >
          Cancelar
        </button>
        <button
          onClick={() => onConfirm({ reason, solution, forwardings, pending: pendencias, tagIds, sendSurvey })}
          disabled={pending}
          className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          Encerrar
        </button>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Transferir atendimento — pessoa/departamento + nota interna + msg ao cliente
// ---------------------------------------------------------------------------
export function TransferModal({
  agents,
  departments,
  currentUserId,
  onConfirm,
  onCancel,
  pending,
}: {
  agents: Profile[];
  departments: Department[];
  currentUserId: string | null;
  onConfirm: (opts: {
    toUserId: string | null;
    toUserIds: string[];
    toDepartmentId: string | null;
    internalNote: string;
    customerMessage: string;
  }) => void;
  onCancel: () => void;
  pending?: boolean;
}) {
  const [mode, setMode] = useState<"person" | "team" | "department">("person");
  const [userId, setUserId] = useState<string | null>(null);
  const [userIds, setUserIds] = useState<string[]>([]); // modo "Vários"
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [internalNote, setInternalNote] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");

  const selectable = agents.filter((a) => a.id !== currentUserId);
  const online = selectable.filter((a) => a.status === "online");
  const offline = selectable.filter((a) => a.status !== "online");

  const canConfirm =
    mode === "person" ? !!userId : mode === "team" ? userIds.length > 0 : !!departmentId;

  function toggleUser(id: string) {
    setUserIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function confirm() {
    onConfirm({
      toUserId: mode === "person" ? userId : null,
      toUserIds: mode === "team" ? userIds : [],
      toDepartmentId: mode === "department" ? departmentId : null,
      internalNote,
      customerMessage,
    });
  }

  return (
    <Overlay onCancel={onCancel}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
          <ArrowRightLeft size={18} className="text-brand" /> Transferir atendimento
        </h2>
        <button onClick={onCancel} className="text-ink-soft hover:text-ink">
          <X size={18} />
        </button>
      </div>

      <div className="mb-4 flex rounded-lg bg-gray-100 p-1 text-sm">
        {(["person", "team", "department"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md py-1.5 font-medium transition ${
              mode === m ? "bg-surface text-ink shadow-sm" : "text-ink-soft"
            }`}
          >
            {m === "person" ? "Pessoa" : m === "team" ? "Vários" : "Departamento"}
          </button>
        ))}
      </div>

      {mode === "team" ? (
        <div className="mb-4">
          <p className="mb-2 text-xs text-ink-soft">
            Oferece para os selecionados — <b>o primeiro que assumir fica</b> com o atendimento.
          </p>
          <div className="max-h-52 overflow-y-auto rounded-lg border border-border">
            {selectable.length === 0 && (
              <p className="p-3 text-xs text-ink-soft">Nenhum outro atendente disponível.</p>
            )}
            {selectable.map((a) => (
              <button
                key={a.id}
                onClick={() => toggleUser(a.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                  userIds.includes(a.id) ? "bg-brand-light" : "hover:bg-gray-50"
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    userIds.includes(a.id) ? "border-brand bg-brand text-white" : "border-border"
                  }`}
                >
                  {userIds.includes(a.id) && <Check size={11} />}
                </span>
                <span
                  className={`h-2 w-2 rounded-full ${a.status === "online" ? "bg-green-500" : "bg-gray-300"}`}
                />
                <span className="text-ink">{a.name || a.email}</span>
              </button>
            ))}
          </div>
          {userIds.length > 0 && (
            <p className="mt-1 text-[11px] text-ink-soft">{userIds.length} atendente(s) selecionado(s).</p>
          )}
        </div>
      ) : mode === "person" ? (
        <div className="mb-4 max-h-52 overflow-y-auto rounded-lg border border-border">
          {selectable.length === 0 && (
            <p className="p-3 text-xs text-ink-soft">Nenhum outro atendente disponível.</p>
          )}
          {[
            { label: "Online", list: online },
            { label: "Offline", list: offline },
          ].map(
            (g) =>
              g.list.length > 0 && (
                <div key={g.label}>
                  <p className="bg-gray-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                    {g.label}
                  </p>
                  {g.list.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setUserId(a.id)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                        userId === a.id ? "bg-brand-light" : "hover:bg-gray-50"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          a.status === "online" ? "bg-green-500" : "bg-gray-300"
                        }`}
                      />
                      <span className="text-ink">{a.name || a.email}</span>
                    </button>
                  ))}
                </div>
              ),
          )}
        </div>
      ) : (
        <select
          value={departmentId ?? ""}
          onChange={(e) => setDepartmentId(e.target.value || null)}
          className={`mb-4 ${inputCls}`}
        >
          <option value="">Selecione um departamento…</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}

      <label className="mb-1.5 block text-xs font-medium text-ink-soft">
        Mensagem interna (só atendentes)
      </label>
      <textarea
        value={internalNote}
        onChange={(e) => setInternalNote(e.target.value)}
        rows={2}
        placeholder="Contexto do atendimento para quem vai assumir…"
        className={`mb-3 resize-none ${inputCls}`}
      />

      <label className="mb-1.5 block text-xs font-medium text-ink-soft">Mensagem ao cliente</label>
      <textarea
        value={customerMessage}
        onChange={(e) => setCustomerMessage(e.target.value)}
        rows={2}
        placeholder="Ex.: Vou te transferir para o setor responsável, um momento."
        className={`mb-4 resize-none ${inputCls}`}
      />

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-ink hover:bg-gray-200"
        >
          Cancelar
        </button>
        <button
          onClick={confirm}
          disabled={!canConfirm || pending}
          className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40"
        >
          <Send size={14} /> Transferir
        </button>
      </div>
    </Overlay>
  );
}
