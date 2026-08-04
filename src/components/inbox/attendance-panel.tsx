"use client";

import { useEffect, useState } from "react";
import {
  Home, User, Receipt, LifeBuoy, Loader2, Save, Check,
  QrCode, Unlock, Wrench, Printer, Plus, Users, Crown, Shield, UserMinus, Search, MessageSquare,
} from "lucide-react";
import { formatPhone } from "@/lib/utils";
import { AttendanceHistory, type AttendanceHistoryItem } from "./attendance-history";
import {
  getContactDetails,
  updateContactDetails,
  getGroupInfo,
  getContactHistory,
  removeGroupParticipant,
  sgpAction,
  sgpSendPix,
  sgpSendBoleto,
  sgpSendSms,
  sgpLookupByCpf,
  type ContactDetails,
  type GroupInfoResult,
  type SgpContrato,
} from "@/app/(app)/atendimento/actions";
import type { ConversationOverview } from "@/lib/types";

// Campos de CRM úteis para um provedor de internet (MVF NET).
const CRM_FIELDS: { key: string; label: string; type?: "text" | "select"; options?: string[] }[] = [
  { key: "cpfcnpj", label: "CPF / CNPJ" },
  { key: "contrato", label: "Nº do contrato (SGP)" },
  { key: "plano", label: "Plano contratado" },
  { key: "status_cliente", label: "Status do cliente", type: "select", options: ["", "Ativo", "Suspenso", "Bloqueado", "Cancelado", "Prospecto"] },
  { key: "empresa", label: "Empresa" },
  { key: "email", label: "E-mail" },
  { key: "endereco", label: "Endereço" },
  { key: "cidade", label: "Cidade / UF" },
];

type TabKey = "inicio" | "cliente" | "financeiro" | "suporte";
const TABS: { key: TabKey; label: string; icon: typeof Home }[] = [
  { key: "inicio", label: "Início", icon: Home },
  { key: "cliente", label: "Cliente", icon: User },
  { key: "financeiro", label: "Financeiro", icon: Receipt },
  { key: "suporte", label: "Suporte", icon: LifeBuoy },
];

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const inputCls = "w-full rounded-lg border border-border px-2.5 py-1.5 text-sm outline-none focus:border-brand";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

/**
 * Painel de atendimento com ABAS (Início / Cliente / Financeiro / Suporte),
 * no estilo Chatmix. Reaproveita as mesmas server actions do ContactPanel.
 */
export function AttendancePanel({
  conversation,
  onOpenContact,
}: {
  conversation: ConversationOverview;
  onOpenContact?: (phone: string, name?: string) => void;
}) {
  const isGroup = !!conversation.is_group;
  const [tab, setTab] = useState<TabKey>("inicio");
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<GroupInfoResult | null>(null);
  const [contact, setContact] = useState<ContactDetails | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState<AttendanceHistoryItem[]>([]);
  const [sgpLoading, setSgpLoading] = useState(false);
  const [sgpMsg, setSgpMsg] = useState<string | null>(null);
  const [sgpContratos, setSgpContratos] = useState<SgpContrato[]>([]); // >1 → seletor
  const [sgpBase, setSgpBase] = useState<{ nome?: string; cpfcnpj?: string; email?: string } | null>(null);

  /** Preenche o cadastro a partir de um contrato específico escolhido. */
  function fillFromContract(ct: SgpContrato, base?: { nome?: string; cpfcnpj?: string; email?: string }) {
    if (base?.nome) setName(base.nome);
    setFields((s) => ({
      ...s,
      cpfcnpj: base?.cpfcnpj ?? s.cpfcnpj,
      contrato: ct.contrato || s.contrato,
      plano: ct.plano ?? s.plano,
      status_cliente: ct.status ?? s.status_cliente,
      endereco: ct.endereco ?? s.endereco,
      email: base?.email || s.email,
    }));
    setSgpContratos([]);
    setSgpBase(null);
    setSgpMsg(`✓ Contrato ${ct.contrato} selecionado. Confira e clique em Salvar.`);
  }

  /** Busca o CPF/CNPJ em TODOS os SGPs. 1 contrato → preenche; vários → seletor. */
  async function doSgpLookup() {
    const cpf = (fields.cpfcnpj ?? "").trim();
    if (!cpf) { setSgpMsg("Digite o CPF/CNPJ primeiro."); return; }
    setSgpLoading(true); setSgpMsg(null); setSgpContratos([]);
    try {
      const r = await sgpLookupByCpf(cpf);
      if (!r.encontrado) { setSgpMsg(r.erro ?? "Cadastro não localizado no SGP."); return; }
      const base = { nome: r.nome, cpfcnpj: r.cpfcnpj, email: r.email };
      if (r.contratos.length <= 1) {
        if (r.contratos[0]) fillFromContract(r.contratos[0], base);
        setSgpMsg(`✓ ${r.nome}. Confira e clique em Salvar.`);
      } else {
        if (r.nome) setName(r.nome);
        setFields((s) => ({ ...s, cpfcnpj: r.cpfcnpj ?? s.cpfcnpj, email: r.email || s.email }));
        setSgpBase(base);
        setSgpContratos(r.contratos);
        setSgpMsg(`✓ ${r.nome} — ${r.contratos.length} contratos. Escolha qual usar:`);
      }
    } catch (e) {
      setSgpMsg(e instanceof Error ? e.message : "Erro na busca do SGP.");
    } finally {
      setSgpLoading(false);
    }
  }

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setSaved(false);
    (async () => {
      try {
        if (isGroup) {
          const g = await getGroupInfo(conversation.id);
          if (!cancel) setGroup(g);
        } else {
          const [c, h] = await Promise.all([
            getContactDetails(conversation.id),
            getContactHistory(conversation.id),
          ]);
          if (!cancel && c) {
            setContact(c);
            setName(c.name ?? "");
            setNotes(c.notes ?? "");
            const cf = (c.custom_fields ?? {}) as Record<string, unknown>;
            setFields(Object.fromEntries(CRM_FIELDS.map((f) => [f.key, String(cf[f.key] ?? "")])));
          }
          if (!cancel) setHistory(h ?? []);
        }
      } catch (e) {
        // Sem este catch, qualquer falha de rede/sessão deixava o painel preso
        // em "Carregando..." para sempre (setLoading(false) nunca rodava).
        console.error("[attendance-panel] carregar dados do contato", e);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [conversation.id, isGroup]);

  async function save() {
    setSaving(true);
    try {
      await updateContactDetails(conversation.id, { name, notes, custom_fields: fields });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  const title = conversation.contact_name ?? (isGroup ? "Grupo" : conversation.contact_phone);

  return (
    <aside className="flex h-full w-80 max-w-[85vw] shrink-0 flex-col border-l border-border bg-surface">
      {/* Cabeçalho: avatar + identidade */}
      <div className="flex flex-col items-center gap-2 border-b border-border p-4 text-center">
        {conversation.contact_avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={conversation.contact_avatar} alt="" className="h-16 w-16 rounded-full object-cover" />
        ) : (
          <div className={`flex h-16 w-16 items-center justify-center rounded-full text-lg font-semibold ${isGroup ? "bg-brand-light text-brand" : "bg-gray-200 text-gray-600"}`}>
            {isGroup ? <Users size={24} /> : title.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div>
          <p className="text-sm font-semibold text-ink">{title}</p>
          {!isGroup && <p className="text-xs text-ink-soft">{formatPhone(conversation.contact_phone)}</p>}
        </div>
      </div>

      {/* Abas */}
      {!isGroup && (
        <div className="flex shrink-0 border-b border-border">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition ${
                tab === key ? "border-b-2 border-brand text-brand" : "text-ink-soft hover:text-ink"
              }`}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-soft">
            <Loader2 size={16} className="animate-spin" /> Carregando...
          </div>
        )}

        {/* GRUPO: participantes */}
        {!loading && isGroup && group && (
          <div className="p-4">
            {group.description && (
              <>
                <p className="mb-1 text-[11px] font-semibold uppercase text-ink-soft">Descrição</p>
                <p className="mb-4 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-ink-soft">{group.description}</p>
              </>
            )}
            <p className="mb-2 text-[11px] font-semibold uppercase text-ink-soft">{group.participants.length} participantes</p>
            <div className="space-y-1">
              {group.participants.map((p) => (
                <button
                  key={p.phone}
                  onClick={() => onOpenContact?.(p.phone, p.name ?? undefined)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-gray-50"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600">
                    {(p.name ?? p.phone).slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{p.name ?? formatPhone(p.phone)}</span>
                    {p.name && <span className="block truncate text-xs text-ink-soft">{formatPhone(p.phone)}</span>}
                  </span>
                  {p.isOwner ? (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-amber-600"><Crown size={12} /> Dono</span>
                  ) : p.isAdmin ? (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-brand"><Shield size={12} /> Admin</span>
                  ) : (
                    <span
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Remover ${p.name ?? p.phone} do grupo?`)) return;
                        const r = await removeGroupParticipant(conversation.id, p.phone);
                        if (r.ok) setGroup((g) => g ? { ...g, participants: g.participants.filter((x) => x.phone !== p.phone) } : g);
                        else alert(r.error ?? "Falha ao remover.");
                      }}
                      className="rounded p-1 text-ink-soft hover:bg-red-50 hover:text-danger"
                      title="Remover do grupo"
                    >
                      <UserMinus size={13} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* CONTATO (não-grupo): conteúdo por aba */}
        {!loading && !isGroup && contact && (
          <div className="p-4">
            {/* ---------- INÍCIO ---------- */}
            {tab === "inicio" && (
              <div className="space-y-4">
                <div className="rounded-lg border border-border p-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase text-ink-soft">Atendimento</p>
                  <dl className="space-y-1.5 text-sm">
                    <Row label="Iniciado em" value={fmtDateTime(conversation.opened_at)} />
                    <Row label="Canal" value={conversation.channel_name ?? "—"} />
                    <Row label="Atendente" value={conversation.assigned_name ?? "—"} />
                    <Row label="Protocolo" value={conversation.protocol ? `#${conversation.protocol}` : "—"} mono />
                  </dl>
                </div>

                <AttendanceHistory items={history} currentId={conversation.id} />
              </div>
            )}

            {/* ---------- CLIENTE (CRM editável) ---------- */}
            {tab === "cliente" && (
              <div className="space-y-3">
                <Field label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
                {CRM_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    {f.key === "cpfcnpj" ? (
                      <div className="space-y-1">
                        <div className="flex gap-1.5">
                          <input
                            value={fields.cpfcnpj ?? ""}
                            onChange={(e) => setFields((s) => ({ ...s, cpfcnpj: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") doSgpLookup(); }}
                            placeholder="CPF ou CNPJ (só números)"
                            className={inputCls}
                          />
                          <button
                            type="button"
                            onClick={doSgpLookup}
                            disabled={sgpLoading}
                            title="Buscar no SGP e preencher os dados"
                            className="flex shrink-0 items-center gap-1 rounded-lg bg-brand px-2.5 text-xs font-medium text-white transition hover:bg-brand-dark disabled:opacity-50"
                          >
                            {sgpLoading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} SGP
                          </button>
                        </div>
                        {sgpMsg && <p className="text-[11px] text-ink-soft">{sgpMsg}</p>}
                        {sgpContratos.length > 1 && (
                          <div className="space-y-1 rounded-lg border border-border p-1.5">
                            {sgpContratos.map((c, i) => (
                              <button
                                key={`${c.sgp}-${c.contrato}-${i}`}
                                type="button"
                                onClick={() => fillFromContract(c, sgpBase ?? undefined)}
                                className="block w-full rounded-md px-2 py-1.5 text-left text-[11px] hover:bg-gray-100"
                              >
                                <span className="font-medium text-ink">Contrato {c.contrato}</span>
                                {c.plano ? ` · ${c.plano}` : ""}
                                {(c.valorEmAberto ?? 0) > 0 ? <span className="ml-1 text-danger">• em aberto</span> : ""}
                                <span className="block text-ink-soft">{[c.endereco, c.sgp].filter(Boolean).join(" — ")}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : f.type === "select" ? (
                      <select value={fields[f.key] ?? ""} onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))} className={inputCls}>
                        {f.options!.map((o) => <option key={o} value={o}>{o || "—"}</option>)}
                      </select>
                    ) : (
                      <input value={fields[f.key] ?? ""} onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))} className={inputCls} />
                    )}
                  </Field>
                ))}
                <button onClick={save} disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-50">
                  {saving ? <Loader2 size={16} className="animate-spin" /> : saved ? <Check size={16} /> : <Save size={16} />}
                  {saved ? "Salvo!" : "Salvar"}
                </button>
                <div className="flex gap-1.5 pt-1">
                  <button type="button" onClick={() => window.print()} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-gray-50 py-2 text-xs font-medium text-ink transition hover:bg-gray-100">
                    <Printer size={13} /> Imprimir
                  </button>
                  <button type="button" onClick={() => onOpenContact?.(contact.phone, contact.name ?? undefined)} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-gray-50 py-2 text-xs font-medium text-ink transition hover:bg-gray-100">
                    <Plus size={13} /> Novo atendimento
                  </button>
                </div>
              </div>
            )}

            {/* ---------- FINANCEIRO (SGP) ---------- */}
            {tab === "financeiro" && (
              <div className="space-y-3">
                <div className="rounded-lg border border-border p-3 text-sm">
                  <Row label="Contrato" value={fields.contrato || "—"} mono />
                  <Row label="Plano" value={fields.plano || "—"} />
                  <Row label="Status" value={fields.status_cliente || "—"} />
                </div>
                {fields.contrato ? (
                  <div>
                    <p className="mb-2 text-[11px] font-semibold uppercase text-ink-soft">Ações SGP</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {([
                        { action: "segunda_via", label: "2ª Via", icon: Receipt },
                        { action: "pix", label: "PIX", icon: QrCode },
                        { action: "liberacao", label: "Liberar", icon: Unlock },
                        { action: "status", label: "Status", icon: Wrench },
                        { action: "sms", label: "SMS", icon: MessageSquare },
                      ] as const).map(({ action, label, icon: Icon }) => (
                        <button key={action} type="button"
                          onClick={async () => {
                            const ct = parseInt(fields.contrato, 10);
                            if (action === "sms") {
                              // SMS de VERDADE via gateway do SGP (Facilita).
                              const texto = prompt("Texto do SMS para o cliente (máx. ~160 caracteres):");
                              if (!texto?.trim()) return;
                              const r = await sgpSendSms(conversation.id, texto, ct);
                              alert(r.message);
                              return;
                            }
                            if (action === "pix") {
                              // PIX: envia o copia-e-cola direto pro cliente na conversa.
                              if (!confirm("Enviar o PIX (copia e cola) para o cliente agora?")) return;
                              const r = await sgpSendPix(conversation.id, ct);
                              alert(r.message);
                              return;
                            }
                            if (action === "segunda_via") {
                              // 2ª via: baixa o BOLETO EM PDF no SGP e envia como documento.
                              if (!confirm("Enviar o boleto (PDF) da fatura mais antiga em aberto para o cliente agora?")) return;
                              const r = await sgpSendBoleto(conversation.id, ct);
                              alert(r.message);
                              return;
                            }
                            const r = await sgpAction(conversation.id, action, ct);
                            alert(typeof r === "string" ? r : JSON.stringify(r, null, 2));
                          }}
                          className="flex items-center justify-center gap-1.5 rounded-lg bg-gray-50 px-2 py-2 text-xs font-medium text-ink transition hover:bg-gray-100">
                          <Icon size={13} /> {label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                    Preencha o <strong>Nº do contrato (SGP)</strong> na aba Cliente para habilitar 2ª via, PIX, liberação e status.
                  </p>
                )}
              </div>
            )}

            {/* ---------- SUPORTE (anotações) ---------- */}
            {tab === "suporte" && (
              <div className="space-y-3">
                <Field label="Anotações do cliente">
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={5} placeholder="Observações, histórico de problemas, preferências…" className={`resize-none ${inputCls}`} />
                </Field>
                <button onClick={save} disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-50">
                  {saving ? <Loader2 size={16} className="animate-spin" /> : saved ? <Check size={16} /> : <Save size={16} />}
                  {saved ? "Salvo!" : "Salvar anotações"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-ink-soft">{label}</dt>
      <dd className={`truncate text-right font-medium text-ink ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
