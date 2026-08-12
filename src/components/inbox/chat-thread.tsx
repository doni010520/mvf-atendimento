"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { UserCheck, CheckCircle2, Users, Bell, BellOff, Reply, X, ArrowRightLeft, Hash, ArrowLeft, Bot, BotOff, StickyNote, Eye, EyeOff, RotateCcw } from "lucide-react";
import { MessageBubble } from "./message-bubble";
import { Composer } from "./composer";
import type { ConversationOverview, Message } from "@/lib/types";

// Controla a exibição dos elementos de IA no chat (selo "IA" + botão Pausar/Reativar).
const SHOW_AI_UI = true;

export function ChatThread({
  conversation,
  messages,
  groupParticipants,
  onSend,
  onSendInternal,
  agents,
  currentUserId,
  hideAi = false,
  isAdmin = false,
  hideHeader = false,
  onSendFile,
  onSendLocation,
  onSendContact,
  onReact,
  onEdit,
  onDelete,
  onAuthorClick,
  onReplyPrivate,
  onOpenPanel,
  onBack,
  onAssign,
  onClose,
  onTransfer,
  onAddNote,
  onToggleMute,
  onToggleAi,
  initialReplyTo,
  onType,
  quickReplies,
  templates,
  onSendTemplate,
  pending,
  messagesLoaded = true,
}: {
  conversation: ConversationOverview;
  messages: Message[];
  /** false enquanto o fetch das mensagens da conversa ainda não retornou. */
  messagesLoaded?: boolean;
  groupParticipants?: { name: string; phone: string }[];
  quickReplies?: { title: string; content: string; shortcut: string | null }[];
  templates?: { name: string; language: string; bodyText: string; varCount: number; channelId?: string | null }[];
  onSendTemplate?: (name: string, language: string, params: string[]) => void;
  onSend: (text: string, replyId?: string, mentions?: { name: string; phone: string }[]) => void;
  onSendInternal?: (text: string, mentions: { id: string; name: string }[]) => void;
  agents?: { id: string; name: string; avatar_url?: string | null }[];
  currentUserId?: string | null;
  hideAi?: boolean;
  isAdmin?: boolean;
  /** Oculta o cabeçalho interno (usado quando o container já tem o seu, ex.: modal do V2). */
  hideHeader?: boolean;
  onSendFile: (file: File, asSticker?: boolean) => void;
  onType?: () => void;
  onSendLocation: () => void;
  onSendContact: () => void;
  onReact: (m: Message, emoji: string) => void;
  onEdit: (m: Message) => void;
  onDelete: (m: Message) => void;
  onAuthorClick: (m: Message) => void;
  onReplyPrivate?: (m: Message) => void;
  onOpenPanel: () => void;
  onBack?: () => void;
  onAssign: () => void;
  onClose: () => void;
  onTransfer: () => void;
  onAddNote?: () => void;
  onToggleMute: () => void;
  onToggleAi: () => void;
  initialReplyTo?: Message | null;
  pending?: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [showInternal, setShowInternal] = useState(true);
  const internalCount = messages.filter((m) => m.is_internal).length;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, conversation.id]);
  useEffect(() => setReplyTo(null), [conversation.id]);
  // Pré-preenche o reply quando vem de "Responder no privado"
  useEffect(() => { if (initialReplyTo) setReplyTo(initialReplyTo); }, [initialReplyTo]);

  const isMeta = conversation.channel_type === "meta_cloud";
  const isGroup = !!conversation.is_group;
  const muted = !!conversation.is_muted;
  const aiPaused = conversation.ai_enabled === false;
  const aiHandling = !aiPaused && conversation.status === "bot";
  // Mostra elementos de IA só se o flag global permitir E o usuário não tiver hide_ai (ex.: revisor).
  const showAi = SHOW_AI_UI && !hideAi;
  const title = conversation.contact_name ?? (isGroup ? "Grupo" : conversation.contact_phone);

  // Janela de 24h da Meta: aberta se a última mensagem recebida do cliente foi < 24h.
  // Canais UAZAPI não têm essa restrição (janela sempre "aberta").
  const lastInboundAt = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].direction === "in") return messages[i].created_at;
    }
    return null;
  })();
  // Anti-flicker SEM furo: enquanto o fetch não voltou (messagesLoaded=false)
  // NÃO assumimos fechada (a barra piscava). Conversa CARREGADA e vazia
  // (iniciar contato) = janela FECHADA por definição → modo modelo. A
  // heurística antiga usava last_message_at, mas conversa NOVA já nasce com
  // ele preenchido (caso Tainá: modelos não apareciam ao chamar cliente).
  const windowOpen =
    !isMeta ||
    !messagesLoaded ||
    (!!lastInboundAt && Date.now() - new Date(lastInboundAt).getTime() < 24 * 3600 * 1000);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-canvas">
      {!hideHeader && (
      <header className="shrink-0 border-b border-border bg-surface">
        {/* Linha 1: avatar + nome + protocolo */}
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 md:px-4">
          {onBack && (
            <button onClick={onBack} className="shrink-0 rounded-lg p-1.5 text-ink-soft hover:bg-gray-100 lg:hidden" title="Voltar">
              <ArrowLeft size={20} />
            </button>
          )}
          <button onClick={onOpenPanel} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left transition hover:bg-gray-50 p-1" title="Ver dados">
            {conversation.contact_avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={conversation.contact_avatar} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
            ) : (
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isGroup ? "bg-brand-light text-brand" : "bg-gray-200 text-gray-600"}`}>
                {isGroup ? <Users size={16} /> : title.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink">
                <span className="truncate">{title}</span>
                <span
                  title={isMeta ? "Canal WhatsApp API Oficial (Meta)" : "Canal WhatsApp (QR Code)"}
                  className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold ${isMeta ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"}`}
                >
                  {isMeta ? "API Oficial" : "Beta"}
                </span>
                {/* Destaque no topo: conversa atribuída a MIM (pedido da equipe). */}
                {currentUserId && conversation.assigned_user_id === currentUserId && (
                  <span className="shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[9px] font-bold text-green-700" title="Este atendimento está atribuído a você">
                    📌 ATRIBUÍDA A VOCÊ
                  </span>
                )}
                {isGroup && <span className="shrink-0 rounded bg-brand-light px-1 py-0.5 text-[9px] font-medium text-brand">Grupo</span>}
                {showAi && aiHandling && <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-violet-100 px-1 py-0.5 text-[9px] font-medium text-violet-700"><Bot size={9} /> IA</span>}
                {showAi && aiPaused && <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-gray-100 px-1 py-0.5 text-[9px] font-medium text-ink-soft"><BotOff size={9} /> IA pausada</span>}
                {muted && <BellOff size={12} className="shrink-0 text-ink-soft" />}
              </p>
              <p className="truncate text-[11px] text-ink-soft">
                {isGroup ? "Conversa de grupo" : conversation.contact_phone}
                {" · "}{conversation.channel_name}
                {conversation.protocol && <span className="ml-1 font-mono text-[10px]">#{conversation.protocol}</span>}
              </p>
            </div>
          </button>
        </div>
        {/* Linha 2: ações */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
          <button onClick={onToggleMute} title={muted ? "Reativar" : "Silenciar"} className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-ink hover:bg-gray-200">
            {muted ? <BellOff size={12} /> : <Bell size={12} />} {muted ? "Silenciado" : "Silenciar"}
          </button>
          {internalCount > 0 && (
            <button
              onClick={() => setShowInternal((v) => !v)}
              title={showInternal ? "Ocultar mensagens internas" : "Mostrar mensagens internas"}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ${
                showInternal ? "bg-amber-100 text-amber-800 hover:bg-amber-200" : "bg-gray-100 text-ink hover:bg-gray-200"
              }`}
            >
              {showInternal ? <Eye size={12} /> : <EyeOff size={12} />} Internas ({internalCount})
            </button>
          )}
          {conversation.status !== "closed" && (
            <>
              {showAi && !isGroup && (
                aiHandling ? (
                  <button onClick={onToggleAi} title="Pausar a IA e atribuir o atendimento a mim" className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-ink hover:bg-gray-200">
                    <BotOff size={12} /> Pausar IA
                  </button>
                ) : (
                  <button onClick={onToggleAi} title="Devolver o atendimento para a IA" className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-2 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-200">
                    <Bot size={12} /> Ativar IA
                  </button>
                )
              )}
              <button onClick={onAssign} title="Atribuir este atendimento a mim" className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-ink hover:bg-gray-200">
                <UserCheck size={12} /> Atribuir
              </button>
              <button onClick={onTransfer} className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-ink hover:bg-gray-200">
                <ArrowRightLeft size={12} /> Transferir
              </button>
              {onAddNote && (
                <button onClick={onAddNote} className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-ink hover:bg-gray-200">
                  <StickyNote size={12} /> Nota
                </button>
              )}
              <button onClick={onClose} className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium text-danger hover:bg-red-100">
                <CheckCircle2 size={12} /> Encerrar
              </button>
            </>
          )}
          {conversation.status === "closed" && (
            <>
              <span className="rounded-md bg-gray-100 px-2 py-1 text-[11px] text-ink-soft">Encerrado</span>
              <button onClick={onAssign} title="Reabrir e atribuir a mim" className="inline-flex items-center gap-1 rounded-md bg-brand-light px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand-light/70">
                <RotateCcw size={12} /> Reabrir
              </button>
            </>
          )}
        </div>
      </header>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="mt-10 text-center text-xs text-ink-soft">Nenhuma mensagem ainda.</p>
        )}
        {(() => {
          // Mapa id-externo (sufixo) → mensagem, para resolver o autor/treco citado.
          const byExt = new Map<string, Message>();
          for (const mm of messages) {
            if (mm.external_id) byExt.set(mm.external_id.split(":").pop()!, mm);
          }
          // Separador de dia ("Hoje"/"Ontem"/data): calculado NA HORA de desenhar,
          // sobre a lista VISÍVEL (internas ocultas não podem abrir separador) e
          // com a hora LOCAL do navegador — created_at é UTC e comparar a string
          // ISO erraria o dia perto da meia-noite.
          const visiveis = messages.filter((m) => !(m.is_internal && !showInternal));
          const diaChave = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
          const rotuloDia = (iso: string) => {
            const d = new Date(iso);
            const hoje = new Date();
            const ontem = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 1);
            if (diaChave(d) === diaChave(hoje)) return "Hoje";
            if (diaChave(d) === diaChave(ontem)) return "Ontem";
            const mesmoAno = d.getFullYear() === hoje.getFullYear();
            return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", ...(mesmoAno ? {} : { year: "numeric" }) });
          };
          let diaAnterior: string | null = null;
          const comSeparador = (m: Message, node: ReactNode) => {
            const dia = diaChave(new Date(m.created_at));
            const divisor =
              dia !== diaAnterior ? (
                <div className="flex justify-center py-2">
                  <span className="rounded-full bg-gray-200/80 px-3 py-1 text-[11px] font-medium text-ink-soft shadow-sm">
                    {rotuloDia(m.created_at)}
                  </span>
                </div>
              ) : null;
            diaAnterior = dia;
            return (
              <Fragment key={m.id}>
                {divisor}
                {node}
              </Fragment>
            );
          };
          return visiveis.map((m) => {
            if (m.is_internal) {
              // Mensagem do sistema (sem autor identificado) = aviso discreto centralizado.
              const isSystem = m.sender_type === "system" || (!m.author_name && !m.sender_id);
              if (isSystem) {
                return comSeparador(
                  m,
                  <div className="flex justify-center px-6 py-1">
                    <div className="max-w-md rounded-lg bg-amber-50 px-3 py-1.5 text-center text-xs text-amber-800 ring-1 ring-amber-100">
                      {m.body}
                    </div>
                  </div>,
                );
              }
              const mine = !!currentUserId && m.sender_id === currentUserId;
              const iAmMentioned = !!currentUserId && (m.mentions ?? []).some((x) => x.id === currentUserId);
              const time = new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
              // Destaca os "@Nome" no corpo.
              const parts = (m.body ?? "").split(/(@[^\s@]+(?:\s[^\s@]+)?)/g);
              return comSeparador(
                m,
                <div className={`flex px-4 py-1 ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[78%] rounded-xl border-l-4 px-3 py-2 text-sm shadow-sm ${
                      iAmMentioned ? "border-amber-500 bg-amber-100 ring-1 ring-amber-300" : "border-amber-400 bg-amber-50"
                    }`}
                  >
                    <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      <span>🔒 Interna</span>
                      <span className="text-amber-600/70">· {m.author_name ?? "Atendente"}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-amber-900">
                      {parts.map((p, i) =>
                        p.startsWith("@") && (m.mentions ?? []).some((x) => p.slice(1).startsWith(x.name)) ? (
                          <span key={i} className="rounded bg-amber-200 px-1 font-medium text-amber-900">{p}</span>
                        ) : (
                          <span key={i}>{p}</span>
                        ),
                      )}
                    </p>
                    <div className="mt-0.5 text-right text-[10px] text-amber-600/70">{time}</div>
                  </div>
                </div>,
              );
            }
            let quotedAuthor: string | null | undefined = m.reply_author;
            let quotedExcerpt: string | null | undefined = m.reply_excerpt;
            if (m.reply_to_external) {
              const q = byExt.get(m.reply_to_external.split(":").pop()!);
              if (q) {
                quotedAuthor = q.author_name ?? (q.direction === "out" ? "Você" : conversation.contact_name);
                quotedExcerpt = q.body ?? (q.content_type !== "text" ? `[${q.content_type}]` : quotedExcerpt);
              }
            }
            return comSeparador(
              m,
              <MessageBubble
                message={m}
                isAdmin={isAdmin}
                onReply={setReplyTo}
                onReact={onReact}
                // Meta (API Oficial) não permite editar msg enviada → esconde o "Editar"
                // para não dar falsa impressão (só a cópia local mudaria).
                onEdit={isMeta ? undefined : onEdit}
                onDelete={isMeta ? undefined : onDelete}
                onAuthorClick={onAuthorClick}
                onReplyPrivate={isGroup ? onReplyPrivate : undefined}
                quotedAuthor={quotedAuthor}
                quotedExcerpt={quotedExcerpt}
              />,
            );
          });
        })()}
        <div ref={endRef} />
      </div>

      {replyTo && (
        <div className="flex items-center gap-2 border-t border-border bg-brand-light/40 px-4 py-2 text-xs">
          <Reply size={14} className="text-brand" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-brand">Respondendo</p>
            <p className="truncate text-ink-soft">
              {replyTo.body ?? (replyTo.content_type !== "text" ? `[${replyTo.content_type}]` : "")}
            </p>
          </div>
          <button onClick={() => setReplyTo(null)} className="text-ink-soft hover:text-ink"><X size={15} /></button>
        </div>
      )}

      <Composer
        onSend={(text, mentions) => {
          onSend(text, replyTo?.external_id ?? undefined, mentions);
          setReplyTo(null);
        }}
        onSendInternal={onSendInternal ? (text, m) => { onSendInternal(text, m); setShowInternal(true); } : undefined}
        agentCandidates={agents?.map((a) => ({ id: a.id, name: a.name }))}
        onSendFile={onSendFile}
        onSendLocation={onSendLocation}
        onSendContact={onSendContact}
        onType={onType}
        quickReplies={quickReplies}
        windowOpen={windowOpen}
        isMeta={isMeta}
        templates={templates}
        channelId={conversation.channel_id}
        contactName={conversation.contact_name}
        onSendTemplate={onSendTemplate}
        mentionCandidates={
          conversation.is_group && groupParticipants?.length
            ? groupParticipants
            : conversation.is_group
              ? Array.from(
                  new Map(
                    messages
                      .filter((m) => m.author_name && m.author_phone)
                      .map((m) => [m.author_phone!, { name: m.author_name!, phone: m.author_phone! }]),
                  ).values(),
                )
              : undefined
        }
        disabled={conversation.status === "closed"}
        sending={pending}
        focusTrigger={replyTo}
      />
    </div>
  );
}
