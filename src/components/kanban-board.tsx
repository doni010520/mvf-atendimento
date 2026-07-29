"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Hash, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { moveConversationStatus } from "@/app/(app)/atendimento-v2/actions";
import { AttendanceChatModal } from "@/components/inbox/attendance-chat-modal";
import type {
  ConversationOverview,
  ConversationStatus,
  Channel,
  Profile,
  Department,
  Tag,
} from "@/lib/types";

type TemplateOpt = { name: string; language: string; bodyText: string; varCount: number };
type QuickReply = { title: string; content: string; shortcut: string | null };

const COLUMNS: { status: ConversationStatus; title: string; dot: string; head: string }[] = [
  { status: "open", title: "Em andamento", dot: "bg-green-500", head: "text-green-700" },
  { status: "queued", title: "Em espera", dot: "bg-amber-500", head: "text-amber-700" },
  { status: "bot", title: "Na automação", dot: "bg-violet-500", head: "text-violet-700" },
];

const selectCls =
  "rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand";

/** "YYYY-MM-DD" de hoje, no fuso local — valor padrão do seletor de data. */
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Compara um timestamp ISO (fuso local) contra um "YYYY-MM-DD" escolhido no seletor. */
function matchesYmd(iso: string | null, ymd: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const target = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return target === ymd;
}

export function KanbanBoard({
  conversations,
  tagMap,
  channels,
  agents,
  departments,
  tags,
  quickReplies,
  templates,
  userId = null,
  hideAi = false,
  isAdmin = false,
}: {
  conversations: ConversationOverview[];
  tagMap: Record<string, string[]>;
  channels: Channel[];
  agents: Profile[];
  departments: Department[];
  tags: Tag[];
  quickReplies?: QuickReply[];
  templates?: TemplateOpt[];
  userId?: string | null;
  hideAi?: boolean;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"board" | "closed" | "analytics">("board");
  const [openConv, setOpenConv] = useState<ConversationOverview | null>(null);
  const [channelId, setChannelId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [deptId, setDeptId] = useState("");
  const [tagId, setTagId] = useState("");
  const [search, setSearch] = useState("");
  // Dia usado pela aba "Encerrados" — combinado com o filtro de canal, é como
  // o atendente confere os atendimentos (e comprovantes de PIX) de um dia
  // específico num canal específico. Antes só dava pra ver o dia de hoje.
  const [closedDate, setClosedDate] = useState(todayYmd());

  // ---------------------------------------------------------------------
  // Atualização automática do board.
  //
  // O Kanban (Atendimento V2) recebe as conversas do servidor e NÃO tinha
  // nenhuma atualização própria: só recarregava depois de uma ação manual.
  // Resultado: mensagem/conversa nova só aparecia com F5. Aqui replicamos o
  // que o Inbox (V1) já faz — realtime + polling de segurança + refresh ao
  // voltar para a aba.
  //
  // Tudo converge para router.refresh(), que refaz o fetch no servidor
  // (getConversations) e re-renderiza com os dados novos.
  // ---------------------------------------------------------------------
  const refreshing = useRef(false);
  useEffect(() => {
    // Agrupa rajadas de eventos: várias mensagens seguidas = um refresh só.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (refreshing.current) return;
        refreshing.current = true;
        router.refresh();
        setTimeout(() => { refreshing.current = false; }, 800);
      }, 400);
    };

    const supabase = createClient();
    const channel = supabase
      .channel("kanban-board")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, scheduleRefresh)
      .subscribe((status) => {
        // Se o socket cair (rede/suspensão), re-sincroniza ao voltar.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") scheduleRefresh();
      });

    // Token renovado → o realtime precisa do token novo, senão para de receber.
    const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "TOKEN_REFRESHED" || event === "SIGNED_IN") && session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
    });

    // Rede de segurança: se o realtime falhar silenciosamente, o board ainda
    // se atualiza sozinho. Só roda com a aba visível, para não gastar à toa.
    const poll = setInterval(() => { if (!document.hidden) scheduleRefresh(); }, 8000);

    // Voltou para a aba → atualiza na hora.
    const onVisible = () => { if (!document.hidden) scheduleRefresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      authSub?.subscription?.unsubscribe();
      supabase.removeChannel(channel);
    };
  }, [router]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (channelId && c.channel_id !== channelId) return false;
      if (agentId && c.assigned_user_id !== agentId) return false;
      if (deptId && c.department_id !== deptId) return false;
      if (tagId && !(tagMap[c.id] ?? []).includes(tagId)) return false;
      if (q) {
        const hay = `${c.contact_name ?? ""} ${c.contact_phone} ${c.protocol ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [conversations, channelId, agentId, deptId, tagId, search, tagMap]);

  const closedToday = useMemo(
    () => filtered.filter((c) => c.status === "closed" && matchesYmd(c.closed_at, closedDate)),
    [filtered, closedDate],
  );

  // Recorrência: conta quantas conversas cada contato tem (todas, não só filtradas)
  const recurrenceCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of conversations) {
      map[c.contact_id] = (map[c.contact_id] ?? 0) + 1;
    }
    return map;
  }, [conversations]);

  return (
    <div className="flex h-full flex-col">
      {/* Abas + filtros */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-6 py-2.5">
        <div className="flex rounded-lg bg-gray-100 p-0.5 text-xs">
          {(
            [
              ["board", "Board"],
              ["closed", "Encerrados"],
              ["analytics", "Visão analítica"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cn(
                "rounded-md px-3 py-1.5 font-medium transition",
                tab === k ? "bg-surface text-ink shadow-sm" : "text-ink-soft",
              )}
            >
              {label}
              {k === "closed" && closedToday.length > 0 && (
                <span className="ml-1 rounded-full bg-gray-200 px-1.5 text-[10px]">{closedToday.length}</span>
              )}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-soft" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nome, telefone ou protocolo…"
              className={cn(selectCls, "w-56 pl-7")}
            />
          </div>
          {(tab === "closed" || tab === "analytics") && (
            <input
              type="date"
              value={closedDate}
              max={todayYmd()}
              onChange={(e) => setClosedDate(e.target.value || todayYmd())}
              title="Ver os encerrados de um dia específico"
              className={selectCls}
            />
          )}
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className={selectCls}>
            <option value="">Todos canais</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={selectCls}>
            <option value="">Todos atendentes</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name || a.email}</option>
            ))}
          </select>
          <select value={deptId} onChange={(e) => setDeptId(e.target.value)} className={selectCls}>
            <option value="">Todos deptos</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className={selectCls}>
            <option value="">Todas tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "board" && <Board conversations={filtered} onOpen={setOpenConv} recurrenceCounts={recurrenceCounts} onMove={async (id, status) => { await moveConversationStatus(id, status).catch(() => {}); router.refresh(); }} />}
        {tab === "closed" && <ClosedList items={closedToday} onOpen={setOpenConv} recurrenceCounts={recurrenceCounts} />}
        {tab === "analytics" && <Analytics conversations={filtered} closedToday={closedToday} />}
      </div>

      {openConv && (
        <AttendanceChatModal
          conversation={openConv}
          agents={agents}
          departments={departments}
          tags={tags}
          quickReplies={quickReplies}
          templates={templates}
          userId={userId}
          hideAi={hideAi}
          isAdmin={isAdmin}
          onClose={() => setOpenConv(null)}
          onChanged={() => router.refresh()}
        />
      )}
    </div>
  );
}

/** Calcula a cor da borda por tempo sem interação (segundos). */
function timeBorderColor(lastMsgAt: string | null): string | null {
  if (!lastMsgAt) return null;
  const sec = (Date.now() - new Date(lastMsgAt).getTime()) / 1000;
  if (sec > 1800) return "#ef4444"; // >30min = vermelho
  if (sec > 600) return "#f59e0b";  // >10min = amarelo
  if (sec > 180) return "#22c55e";  // >3min = verde
  return null;
}

function Card({ c, onOpen, recurrenceCount, draggable, onDragStart }: { c: ConversationOverview; onOpen: (c: ConversationOverview) => void; recurrenceCount?: number; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void }) {
  const initials = (c.contact_name ?? c.contact_phone)
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  const time = c.last_message_at
    ? new Date(c.last_message_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : "";
  const borderColor = c.status !== "closed" ? timeBorderColor(c.last_message_created_at ?? c.last_message_at) : null;
  const recLabel = recurrenceCount != null && recurrenceCount >= 2
    ? recurrenceCount >= 10 ? "Alta recorrência" : recurrenceCount >= 5 ? "Média recorrência" : "Baixa recorrência"
    : null;
  const recColor = recurrenceCount != null && recurrenceCount >= 10 ? "text-red-600 bg-red-50" : recurrenceCount != null && recurrenceCount >= 5 ? "text-amber-600 bg-amber-50" : "text-green-600 bg-green-50";
  // Acento à esquerda: cor do departamento (como no Chatmix); senão, SLA por tempo.
  const accent = c.department_color || borderColor;
  return (
    <button
      onClick={() => onOpen(c)}
      draggable={draggable}
      onDragStart={onDragStart}
      className={cn(
        "w-full overflow-hidden rounded-lg border border-border bg-surface text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-pop",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      <div className="p-3">
        <div className="flex items-center gap-2">
          {c.contact_avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.contact_avatar} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas text-[10px] font-semibold text-ink-soft">
              {initials || "?"}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{c.contact_name ?? c.contact_phone}</p>
            <p className="truncate text-[11px] text-ink-soft">{c.channel_name}</p>
          </div>
          <span className="tnum shrink-0 text-[10px] text-ink-soft">{time}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {c.status === "bot" && (
            <span className="inline-flex items-center gap-1 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-700">
              🔥 AGENTE DE IA
            </span>
          )}
          {c.assigned_name && (
            <span className="rounded bg-brand-light px-1.5 py-0.5 text-[10px] font-medium text-brand">
              {c.assigned_name}
            </span>
          )}
          {c.department_name && (
            <span className="rounded bg-canvas px-1.5 py-0.5 text-[10px] text-ink-soft">{c.department_name}</span>
          )}
          {c.protocol && (
            <span className="tnum inline-flex items-center gap-0.5 rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
              <Hash size={9} />
              {c.protocol}
            </span>
          )}
          {recLabel && (
            <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${recColor}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" /> {recLabel}
            </span>
          )}
        </div>

        {(() => {
          const ml: Record<string, string> = { image: "📷 Foto", video: "🎥 Vídeo", audio: "🎵 Áudio", document: "📄 Documento", sticker: "🏷️ Figurinha", location: "📍 Localização", contact: "👤 Contato" };
          const txt = c.last_message_body || (c.last_message_type ? ml[c.last_message_type] : null);
          return txt ? <p className="mt-2 line-clamp-2 text-xs text-ink-soft">{txt}</p> : null;
        })()}
      </div>
    </button>
  );
}

function Board({ conversations, onOpen, recurrenceCounts, onMove }: { conversations: ConversationOverview[]; onOpen: (c: ConversationOverview) => void; recurrenceCounts: Record<string, number>; onMove: (id: string, status: "open" | "queued" | "bot") => void }) {
  const [dragOver, setDragOver] = useState<string | null>(null);
  return (
    <div className="grid h-full grid-cols-1 gap-4 overflow-hidden p-6 md:grid-cols-3">
      {COLUMNS.map((col) => {
        const items = conversations.filter((c) => c.status === col.status);
        return (
          <div
            key={col.status}
            onDragOver={(e) => { e.preventDefault(); setDragOver(col.status); }}
            onDragLeave={() => setDragOver((s) => (s === col.status ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const id = e.dataTransfer.getData("text/conversation-id");
              const from = e.dataTransfer.getData("text/from-status");
              if (id && from !== col.status) onMove(id, col.status as "open" | "queued" | "bot");
            }}
            className={cn(
              "flex min-h-0 flex-col rounded-card bg-gray-50/70 transition",
              dragOver === col.status && "ring-2 ring-brand ring-offset-1",
            )}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", col.dot)} />
                <h3 className={cn("text-sm font-semibold", col.head)}>{col.title}</h3>
              </div>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-ink-soft">{items.length}</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {items.length === 0 && <p className="pt-6 text-center text-xs text-ink-soft">Arraste atendimentos para cá.</p>}
              {items.map((c) => (
                <Card
                  key={c.id}
                  c={c}
                  onOpen={onOpen}
                  recurrenceCount={recurrenceCounts?.[c.contact_id]}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/conversation-id", c.id);
                    e.dataTransfer.setData("text/from-status", c.status);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ClosedList({ items, onOpen, recurrenceCounts }: { items: ConversationOverview[]; onOpen: (c: ConversationOverview) => void; recurrenceCounts: Record<string, number> }) {
  return (
    <div className="h-full overflow-y-auto p-6">
      {items.length === 0 ? (
        <p className="pt-10 text-center text-sm text-ink-soft">Nenhum atendimento encerrado hoje.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((c) => (
            <Card key={c.id} c={c} onOpen={onOpen} recurrenceCount={recurrenceCounts?.[c.contact_id]} />
          ))}
        </div>
      )}
    </div>
  );
}

function Analytics({
  conversations,
  closedToday,
}: {
  conversations: ConversationOverview[];
  closedToday: ConversationOverview[];
}) {
  const open = conversations.filter((c) => c.status === "open").length;
  const queued = conversations.filter((c) => c.status === "queued").length;
  const bot = conversations.filter((c) => c.status === "bot").length;

  // TMA (tempo médio de atendimento) dos encerrados hoje.
  const durations = closedToday
    .filter((c) => c.opened_at && c.closed_at)
    .map((c) => new Date(c.closed_at!).getTime() - new Date(c.opened_at!).getTime())
    .filter((ms) => ms > 0);
  const tmaMin = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000)
    : 0;

  const rated = closedToday.filter((c) => typeof c.satisfaction === "number");
  const csat = rated.length
    ? (rated.reduce((a, c) => a + (c.satisfaction ?? 0), 0) / rated.length).toFixed(1)
    : "—";

  const cards = [
    { label: "Em andamento", value: open, color: "text-green-700" },
    { label: "Em espera", value: queued, color: "text-amber-700" },
    { label: "Na automação", value: bot, color: "text-violet-700" },
    { label: "Encerrados", value: closedToday.length, color: "text-ink" },
    { label: "TMA (min)", value: tmaMin, color: "text-brand" },
  ];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card bg-surface p-4 shadow-sm">
            <p className="text-xs text-ink-soft">{c.label}</p>
            <p className={cn("mt-1 text-2xl font-semibold", c.color)}>{c.value}</p>
          </div>
        ))}
        <div className="rounded-card bg-surface p-4 shadow-sm">
          <p className="text-xs text-ink-soft">Satisfação média</p>
          <p className="mt-1 flex items-center gap-1 text-2xl font-semibold text-yellow-500">
            <Star size={20} className="fill-yellow-400 text-yellow-400" /> {csat}
          </p>
        </div>
      </div>
    </div>
  );
}
