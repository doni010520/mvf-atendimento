"use client";

import { useMemo, useState } from "react";
import { Search, Users, BellOff, BotOff, Bot, SlidersHorizontal, X, Trash2, Check, PenSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationOverview, ConversationStatus } from "@/lib/types";

/* ─── Abas de status (topo) ─── */
const STATUS_TABS: { key: ConversationStatus | "all"; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "queued", label: "Em espera" },
  { key: "open", label: "Em andamento" },
  { key: "closed", label: "Encerrados" },
];

/** Formata hora de forma determinística (sem toLocaleTimeString que causa hydration mismatch). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const STATUS_DOT: Record<ConversationStatus, string> = {
  bot: "bg-violet-500",
  queued: "bg-amber-500",
  open: "bg-green-500",
  closed: "bg-gray-400",
};

/* ─── Período: Todas / Hoje / Ontem / Não lidas ─── */
type PeriodKey = "all" | "today" | "yesterday" | "unread";
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "all", label: "Todas" },
  { key: "today", label: "Hoje" },
  { key: "yesterday", label: "Ontem" },
  { key: "unread", label: "Não lidas" },
];

function startOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/* ─── Componente auxiliar: multi-select dropdown inline ─── */
function MultiSelect({
  label,
  placeholder,
  options,
  selected,
  onChange,
}: {
  label: string;
  placeholder: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink">{label}</label>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-sm text-ink-soft hover:border-gray-300"
      >
        <span className="truncate">
          {selected.length === 0
            ? placeholder
            : `${selected.length} selecionado${selected.length > 1 ? "s" : ""}`}
        </span>
        <SlidersHorizontal size={14} className="shrink-0" />
      </button>
      {open && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-white shadow-lg">
          {options.length === 0 && (
            <p className="px-3 py-2 text-xs text-ink-soft">Nenhuma opção.</p>
          )}
          {options.map((o) => {
            const checked = selected.includes(o.value);
            return (
              <button
                key={o.value}
                onClick={() => toggle(o.value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    checked ? "border-brand bg-brand text-white" : "border-gray-300",
                  )}
                >
                  {checked && <Check size={10} />}
                </span>
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Componente principal ─── */
export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onPauseAi,
  onNewConversation,
  userId = null,
}: {
  conversations: ConversationOverview[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPauseAi?: (id: string) => void;
  onNewConversation?: () => void;
  userId?: string | null;
}) {
  const [statusTab, setStatusTab] = useState<ConversationStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  // Filtros do modal (estado aplicado)
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);

  // Filtros pendentes (dentro do modal, antes de "Aplicar")
  const [draftPeriod, setDraftPeriod] = useState<PeriodKey>("all");
  const [draftChannels, setDraftChannels] = useState<string[]>([]);
  const [draftDepts, setDraftDepts] = useState<string[]>([]);

  const hasActiveFilters = period !== "all" || channelIds.length > 0 || departmentIds.length > 0;

  // Extrair opções únicas de canal e departamento
  const channelOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations) {
      if (c.channel_id && c.channel_name) map.set(c.channel_id, c.channel_name);
    }
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [conversations]);

  const deptOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations) {
      if (c.department_id && c.department_name) map.set(c.department_id, c.department_name);
    }
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [conversations]);

  // Filtragem
  const filtered = useMemo(() => {
    const now = new Date();
    const todayStart = startOfDay(now);
    const yesterdayStart = startOfDay(new Date(now.getTime() - 86400000));
    return conversations.filter((c) => {
      // Aba de status. "Todos" = tudo que ainda está em andamento (bot/em
      // espera/em andamento) — encerrados têm aba própria e não entram aqui.
      if (statusTab === "all") {
        if (c.status === "closed") return false;
      } else if (c.status !== statusTab) {
        return false;
      }
      // "Em andamento" = SÓ as minhas (atribuídas a mim), inclusive p/ admin —
      // que em "Todos" vê tudo, mas em "Em andamento" quer só o que ele assumiu.
      if (statusTab === "open" && userId && c.assigned_user_id !== userId) return false;
      // Busca textual
      if (query) {
        const q = query.toLowerCase();
        if (
          !(c.contact_name ?? "").toLowerCase().includes(q) &&
          !c.contact_phone.includes(q) &&
          !(c.channel_name ?? "").toLowerCase().includes(q)
        )
          return false;
      }
      // Período
      if (period === "unread") {
        if ((c.unread_count ?? 0) === 0) return false;
      } else if (period === "today" || period === "yesterday") {
        const ts = c.last_message_at ? new Date(c.last_message_at) : null;
        if (!ts) return false;
        if (period === "today" && ts < todayStart) return false;
        if (period === "yesterday" && (ts < yesterdayStart || ts >= todayStart)) return false;
      }
      // Canal
      if (channelIds.length > 0 && !channelIds.includes(c.channel_id)) return false;
      // Departamento
      if (departmentIds.length > 0 && (!c.department_id || !departmentIds.includes(c.department_id)))
        return false;
      return true;
    });
  }, [conversations, statusTab, query, period, channelIds, departmentIds]);

  function openModal() {
    setDraftPeriod(period);
    setDraftChannels([...channelIds]);
    setDraftDepts([...departmentIds]);
    setModalOpen(true);
  }
  function applyFilters() {
    setPeriod(draftPeriod);
    setChannelIds(draftChannels);
    setDepartmentIds(draftDepts);
    setModalOpen(false);
  }
  function clearFilters() {
    setDraftPeriod("all");
    setDraftChannels([]);
    setDraftDepts([]);
  }

  return (
    <div className="flex h-full w-full shrink-0 flex-col border-r border-border bg-surface md:w-80">
      {/* ─── Header: busca + abas + filtro ─── */}
      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar conversa..."
              className="w-full rounded-lg border border-border py-2 pl-9 pr-3 text-sm outline-none focus:border-brand"
            />
          </div>
          {onNewConversation && (
            <button
              onClick={onNewConversation}
              title="Novo atendimento"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-brand text-white transition hover:bg-brand-dark"
            >
              <PenSquare size={16} />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1">
          <div className="flex flex-1 gap-1 overflow-x-auto">
            {STATUS_TABS.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusTab(f.key)}
                className={cn(
                  "whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium transition",
                  statusTab === f.key
                    ? "bg-brand text-white"
                    : "bg-gray-100 text-ink-soft hover:bg-gray-200",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            onClick={openModal}
            title="Filtros avançados"
            className={cn(
              "relative shrink-0 rounded-lg p-1.5 transition",
              hasActiveFilters
                ? "bg-brand text-white hover:bg-brand/90"
                : "text-ink-soft hover:bg-gray-100",
            )}
          >
            <SlidersHorizontal size={16} />
            {hasActiveFilters && (
              <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[8px] font-bold text-white">
                !
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ─── Lista de conversas ─── */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="p-6 text-center text-xs text-ink-soft">Nenhuma conversa.</p>
        )}
        {filtered.map((c) => {
          const isGroup = !!c.is_group;
          const title = c.contact_name ?? (isGroup ? "Grupo" : c.contact_phone);
          const initials = title
            .split(" ")
            .slice(0, 2)
            .map((w) => w[0]?.toUpperCase())
            .join("");
          const time = c.last_message_at ? fmtTime(c.last_message_at) : "";
          const mediaLabel: Record<string, string> = {
            image: "📷 Foto",
            video: "🎥 Vídeo",
            audio: "🎵 Áudio",
            document: "📄 Documento",
            sticker: "🏷️ Figurinha",
            location: "📍 Localização",
            contact: "👤 Contato",
            template: "📋 Template",
          };
          const bodyOrMedia =
            c.last_message_body ||
            (c.last_message_type
              ? mediaLabel[c.last_message_type] ?? `[${c.last_message_type}]`
              : "—");
          const preview =
            isGroup && c.last_message_author && c.last_message_direction === "in"
              ? `${c.last_message_author.split(" ")[0]}: ${bodyOrMedia}`
              : bodyOrMedia;
          const unread = (c.unread_count ?? 0) > 0;
          const aiActive = c.status === "bot" && c.ai_enabled !== false;
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(c.id)}
              onKeyDown={(e) =>
                (e.key === "Enter" || e.key === " ") && onSelect(c.id)
              }
              className={cn(
                "group flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 py-3 text-left transition hover:bg-gray-50",
                selectedId === c.id && "bg-brand-light hover:bg-brand-light",
              )}
            >
              <div className="relative h-10 w-10 shrink-0">
                {c.contact_avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.contact_avatar}
                    alt=""
                    className="h-10 w-10 rounded-full object-cover"
                  />
                ) : (
                  <div
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-full text-xs font-semibold",
                      isGroup
                        ? "bg-brand-light text-brand"
                        : "bg-gray-200 text-gray-600",
                    )}
                  >
                    {isGroup ? <Users size={18} /> : initials || "?"}
                  </div>
                )}
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white",
                    STATUS_DOT[c.status],
                  )}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p
                    className={cn(
                      "flex min-w-0 items-center gap-1 truncate text-sm",
                      unread ? "font-bold text-ink" : "font-medium text-ink",
                    )}
                  >
                    <span className="truncate">{title}</span>
                    {aiActive && (
                      <Bot
                        size={12}
                        className="shrink-0 text-violet-500"
                        aria-label="Atendida pela IA"
                      />
                    )}
                    {c.is_muted && (
                      <BellOff size={12} className="shrink-0 text-ink-soft" />
                    )}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    {aiActive && onPauseAi && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onPauseAi(c.id);
                        }}
                        title="Pausar IA e atribuir a mim"
                        className="rounded p-0.5 text-ink-soft opacity-0 transition hover:bg-violet-100 hover:text-violet-700 group-hover:opacity-100"
                      >
                        <BotOff size={14} />
                      </button>
                    )}
                    <span
                      className={cn(
                        "text-[10px]",
                        unread
                          ? "font-semibold text-green-600"
                          : "text-ink-soft",
                      )}
                    >
                      {time}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <p
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      unread ? "font-semibold text-ink" : "text-ink-soft",
                    )}
                  >
                    {preview}
                  </p>
                  {unread && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-green-500 px-1 text-[10px] font-bold text-white">
                      {c.unread_count! > 99 ? "99+" : c.unread_count}
                    </span>
                  )}
                </div>
                <p className="truncate text-[10px] text-ink-soft/70">
                  {c.channel_name}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── Modal de filtros avançados ─── */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={(e) => e.target === e.currentTarget && setModalOpen(false)}
        >
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-ink">Filtrar atendimentos</h3>
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1 text-ink-soft hover:bg-gray-100"
              >
                <X size={18} />
              </button>
            </div>

            {/* Período */}
            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium text-ink">
                Conversas
              </label>
              <p className="mb-2 text-xs text-ink-soft">
                Por período (última mensagem) ou não lidas
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => setDraftPeriod(p.key)}
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium transition",
                      draftPeriod === p.key
                        ? "bg-brand text-white"
                        : "bg-gray-100 text-ink-soft hover:bg-gray-200",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Canais */}
            <div className="mb-4">
              <MultiSelect
                label="Canais"
                placeholder="Filtre por canais"
                options={channelOptions}
                selected={draftChannels}
                onChange={setDraftChannels}
              />
            </div>

            {/* Departamentos */}
            <div className="mb-6">
              <MultiSelect
                label="Departamentos"
                placeholder="Filtre por departamentos"
                options={deptOptions}
                selected={draftDepts}
                onChange={setDraftDepts}
              />
            </div>

            {/* Ações */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setModalOpen(false)}
                className="text-sm text-ink-soft hover:text-ink"
              >
                Cancelar
              </button>
              <div className="flex gap-2">
                <button
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-gray-50"
                >
                  <Trash2 size={12} /> Limpar filtros
                </button>
                <button
                  onClick={applyFilters}
                  className="inline-flex items-center gap-1 rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand/90"
                >
                  <SlidersHorizontal size={12} /> Aplicar filtros
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
