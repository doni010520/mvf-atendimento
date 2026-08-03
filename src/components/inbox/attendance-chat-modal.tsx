"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { X, UserCheck, ArrowRightLeft, CheckCircle2, Hash, Clock, PanelRight, RotateCcw } from "lucide-react";
import { ChatThread } from "./chat-thread";
import { AttendancePanel } from "./attendance-panel";
import { CloseModal, TransferModal } from "./attendance-modals";
import { toast } from "@/components/toast";
import {
  fetchMessages,
  markConversationRead,
  sendMessage,
  sendInternalMessage,
  sendMediaMessage,
  sendLocationMessage,
  sendContactMessage,
  sendTemplateMessage,
  reactToMessage,
  editMessageAction,
  deleteMessageAction,
  assignToMe,
  addInternalNote,
  closeConversation,
  transferConversation,
  toggleMute,
  setConversationAi,
} from "@/app/(app)/atendimento/actions";
import type { ConversationOverview, Message, Tag, Profile, Department } from "@/lib/types";

type TemplateOpt = { name: string; language: string; bodyText: string; varCount: number };
type QuickReply = { title: string; content: string; shortcut: string | null };

/** Formata "0 dias 2 h 48 min 21 s" (estilo Chatmix). */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${days} dias ${h} h ${m} min ${sec} s`;
}

/**
 * Modal de atendimento do Kanban (V2): abre ao clicar num card e permite atender
 * o cliente sem sair da tela. Reaproveita o ChatThread (chat + envio) e o
 * ContactPanel (dados/CRM/SGP/histórico), com o cabeçalho no estilo Chatmix.
 */
export function AttendanceChatModal({
  conversation,
  agents,
  departments,
  tags,
  quickReplies,
  templates,
  userId,
  hideAi = false,
  isAdmin = false,
  onClose,
  onChanged,
}: {
  conversation: ConversationOverview;
  agents: Profile[];
  departments: Department[];
  tags: Tag[];
  quickReplies?: QuickReply[];
  templates?: TemplateOpt[];
  userId: string | null;
  hideAi?: boolean;
  isAdmin?: boolean;
  onClose: () => void;
  /** Chamado quando algo muda (assumir/encerrar/transferir) para o Kanban recarregar. */
  onChanged?: () => void;
}) {
  const convId = conversation.id;
  // Cópia local para refletir toggles (mudo/IA/assumir) na hora no cabeçalho/ChatThread.
  const [conv, setConv] = useState<ConversationOverview>(conversation);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  const [closing, setClosing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [noting, setNoting] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [showPanelMobile, setShowPanelMobile] = useState(false);

  const [startMs] = useState(() =>
    conversation.opened_at ? Date.parse(conversation.opened_at) : Date.now(),
  );
  const [elapsed, setElapsed] = useState("");

  // Tempo decorrido ao vivo (1s).
  useEffect(() => {
    const tick = () => setElapsed(fmtElapsed(Date.now() - startMs));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startMs]);

  // Carrega mensagens + polling 8s (pausa com a aba oculta — economiza Disk IO).
  useEffect(() => {
    let cancel = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const m = await fetchMessages(convId);
        if (!cancel) setMessages(m);
      } catch { /* silencioso */ }
    };
    load();
    markConversationRead(convId).catch(() => {});
    const t = setInterval(load, 8000);
    return () => { cancel = true; clearInterval(t); };
  }, [convId]);

  // Fecha no ESC — mas NÃO quando há um sub-modal aberto (encerrar/transferir/
  // nota/editar/apagar): antes o ESC dentro deles fechava o atendimento inteiro
  // e o atendente perdia o que tinha digitado.
  const subModalOpen = closing || transferring || noting || !!editing || !!deleteTarget;
  useEffect(() => {
    if (subModalOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, subModalOpen]);

  // Fechar clicando no fundo só vale quando o clique COMEÇOU e TERMINOU no
  // fundo. Sem isso, selecionar texto e soltar o mouse fora, ou clicar num
  // elemento que some (menu/tooltip), fechava o atendimento sem querer.
  const backdropDownRef = useRef(false);

  const refetch = async () => {
    try { setMessages(await fetchMessages(convId)); } catch { /* silencioso */ }
  };

  // ----------------------------- Handlers -----------------------------
  function handleSend(text: string, replyId?: string, mentions?: { name: string; phone: string }[]) {
    const optimistic: Message = {
      id: `tmp-${Date.now()}`,
      organization_id: "",
      conversation_id: convId,
      direction: "out",
      sender_type: "agent",
      sender_id: userId,
      content_type: "text",
      body: text,
      media_url: null,
      status: "pending",
      external_id: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    startTransition(async () => {
      const r = await sendMessage(convId, text, replyId, mentions);
      if (r && r.ok === false) toast(r.error ?? "Mensagem não entregue.", "error");
      await refetch();
    });
  }

  function handleSendInternal(text: string, mentions: { id: string; name: string }[]) {
    startTransition(async () => {
      await sendInternalMessage(convId, text, mentions);
      await refetch();
    });
  }

  function handleSendFile(file: File, asSticker?: boolean) {
    const fd = new FormData();
    fd.set("conversationId", convId);
    fd.set("file", file);
    const caption = (file as File & { caption?: string }).caption;
    if (caption) fd.set("caption", caption);
    if (asSticker) fd.set("kind", "sticker");
    startTransition(async () => {
      await sendMediaMessage(fd);
      await refetch();
    });
  }

  function handleSendTemplate(name: string, language: string, params: string[]) {
    startTransition(async () => {
      const r = await sendTemplateMessage(convId, name, language, params);
      if (r?.ok) toast("Modelo enviado.");
      else toast(r?.error ?? "Falha ao enviar o modelo.", "error");
      await refetch();
    });
  }

  function handleSendLocation() {
    if (!navigator.geolocation) {
      alert("Geolocalização não disponível neste dispositivo.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => startTransition(async () => {
        await sendLocationMessage(convId, { latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        await refetch();
      }),
      () => alert("Não foi possível obter a localização."),
    );
  }

  function handleSendContact() {
    const name = window.prompt("Nome do contato:");
    if (!name) return;
    const phone = window.prompt("Telefone (com DDI+DDD, só números):");
    if (!phone) return;
    startTransition(async () => {
      await sendContactMessage(convId, name, phone);
      await refetch();
    });
  }

  function handleReact(m: Message, emoji: string) {
    startTransition(async () => {
      await reactToMessage(convId, m.id, emoji);
      await refetch();
    });
  }

  function saveEdit() {
    if (!editing) return;
    const { id, text } = editing;
    setEditing(null);
    startTransition(async () => {
      await editMessageAction(convId, id, text);
      await refetch();
    });
  }

  function confirmDelete(scope: "me" | "everyone") {
    const m = deleteTarget;
    setDeleteTarget(null);
    if (!m) return;
    startTransition(async () => {
      await deleteMessageAction(convId, m.id, scope);
      await refetch();
    });
  }

  function handleAssign() {
    setConv((c) => ({ ...c, status: "open", assigned_user_id: userId }));
    startTransition(async () => {
      await assignToMe(convId);
      onChanged?.();
    });
  }

  function confirmClose(opts: { reason: string; solution: string; forwardings: string; pending: string; tagIds: string[]; sendSurvey: boolean }) {
    setClosing(false);
    startTransition(async () => {
      await closeConversation(convId, opts);
      toast("Atendimento encerrado.");
      onChanged?.();
      onClose();
    });
  }

  function confirmTransfer(opts: {
    toUserId: string | null;
    toUserIds: string[];
    toDepartmentId: string | null;
    internalNote: string;
    customerMessage: string;
  }) {
    setTransferring(false);
    startTransition(async () => {
      await transferConversation(convId, opts);
      toast("Atendimento transferido.");
      onChanged?.();
      onClose();
    });
  }

  function confirmNote() {
    const text = noteText.trim();
    if (!text) return;
    setNoting(false);
    startTransition(async () => {
      await addInternalNote(convId, text);
      await refetch();
    });
  }

  function handleToggleMute() {
    const next = !conv.is_muted;
    setConv((c) => ({ ...c, is_muted: next }));
    startTransition(() => toggleMute(convId, next).then(() => undefined));
  }

  function handleToggleAi() {
    // "IA conduzindo" = ai_enabled e status bot. Conduzindo → pausa; humano → ativa.
    const aiHandling = conv.ai_enabled !== false && conv.status === "bot";
    const next = !aiHandling;
    setConv((c) => ({ ...c, ai_enabled: next, status: next ? "bot" : "open" }));
    startTransition(async () => {
      await setConversationAi(convId, next);
      await refetch();
    });
  }

  const protocol = conv.protocol;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-0 sm:p-4"
      onMouseDown={(e) => { backdropDownRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropDownRef.current) onClose();
        backdropDownRef.current = false;
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col overflow-hidden bg-surface shadow-2xl sm:h-[92vh] sm:max-w-6xl sm:rounded-2xl"
      >
        {/* Cabeçalho estilo Chatmix: tempo decorrido + protocolo + ações */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-brand-light/40 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <span className="flex items-center gap-1.5 text-ink-soft">
              <Clock size={14} /> Tempo decorrido
              <span className="font-mono font-medium text-ink" suppressHydrationWarning>{elapsed}</span>
            </span>
            {protocol && (
              <span className="flex items-center gap-1 text-ink-soft">
                Protocolo
                <span className="inline-flex items-center gap-0.5 font-mono font-medium text-ink">
                  <Hash size={12} />{protocol}
                </span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {conv.status !== "closed" && (
              <>
                <button onClick={handleAssign} title="Atribuir este atendimento a mim" className="inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-gray-100">
                  <UserCheck size={14} /> Atribuir
                </button>
                <button onClick={() => setTransferring(true)} title="Transferir" className="inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-gray-100">
                  <ArrowRightLeft size={14} /> Transferir
                </button>
                <button onClick={() => setClosing(true)} title="Encerrar" className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-danger shadow-sm hover:bg-red-100">
                  <CheckCircle2 size={14} /> Encerrar
                </button>
              </>
            )}
            {conv.status === "closed" && (
              <button onClick={handleAssign} title="Reabrir e atribuir a mim" className="inline-flex items-center gap-1 rounded-md bg-brand-light px-2.5 py-1.5 text-xs font-medium text-brand shadow-sm hover:bg-brand-light/70">
                <RotateCcw size={14} /> Reabrir
              </button>
            )}
            <button onClick={() => setShowPanelMobile(true)} title="Dados do contato" className="rounded-md p-1.5 text-ink-soft hover:bg-gray-100 hover:text-ink lg:hidden">
              <PanelRight size={18} />
            </button>
            <button onClick={onClose} title="Fechar" className="ml-1 rounded-md p-1.5 text-ink-soft hover:bg-gray-100 hover:text-ink">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Corpo: chat (esquerda) + painel de contato em abas (direita, dockado em telas largas) */}
        <div className="relative flex min-h-0 flex-1">
          <ChatThread
            conversation={conv}
            messages={messages}
            hideHeader
            agents={agents.map((a) => ({ id: a.id, name: a.name ?? "Atendente", avatar_url: a.avatar_url }))}
            currentUserId={userId}
            hideAi={hideAi}
            isAdmin={isAdmin}
            onSend={handleSend}
            onSendInternal={handleSendInternal}
            onSendFile={handleSendFile}
            onSendLocation={handleSendLocation}
            onSendContact={handleSendContact}
            onSendTemplate={handleSendTemplate}
            onReact={handleReact}
            onEdit={(m) => setEditing({ id: m.id, text: m.body ?? "" })}
            onDelete={setDeleteTarget}
            onAuthorClick={() => {}}
            onOpenPanel={() => {}}
            onAssign={handleAssign}
            onClose={() => setClosing(true)}
            onTransfer={() => setTransferring(true)}
            onAddNote={() => setNoting(true)}
            onToggleMute={handleToggleMute}
            onToggleAi={handleToggleAi}
            quickReplies={quickReplies}
            templates={templates}
            pending={isPending}
          />
          {/* Desktop: painel dockado. Mobile: gaveta acionada pelo botão do cabeçalho. */}
          <div className="hidden h-full lg:block">
            <AttendancePanel conversation={conv} />
          </div>
          {showPanelMobile && (
            <div className="absolute inset-0 z-[75] flex justify-end lg:hidden">
              <div className="absolute inset-0 bg-black/40" onClick={() => setShowPanelMobile(false)} />
              <div className="relative h-full">
                <button
                  onClick={() => setShowPanelMobile(false)}
                  title="Fechar"
                  className="absolute -left-9 top-2 rounded-full bg-surface p-1.5 text-ink-soft shadow hover:text-ink"
                >
                  <X size={16} />
                </button>
                <AttendancePanel conversation={conv} />
              </div>
            </div>
          )}
        </div>

        {/* Sub-modais */}
        {closing && (
          <CloseModal
            tags={tags}
            protocol={protocol}
            onConfirm={confirmClose}
            onCancel={() => setClosing(false)}
            pending={isPending}
          />
        )}
        {transferring && (
          <TransferModal
            agents={agents}
            departments={departments}
            currentUserId={userId}
            onConfirm={confirmTransfer}
            onCancel={() => setTransferring(false)}
            pending={isPending}
          />
        )}
        {noting && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={() => setNoting(false)}>
            <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-ink">Nota interna</h2>
                <button onClick={() => setNoting(false)} className="text-ink-soft hover:text-ink"><X size={18} /></button>
              </div>
              <p className="mb-2 text-xs text-ink-soft">Visível apenas para a equipe — não é enviada ao cliente.</p>
              <textarea
                autoFocus
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirmNote(); }
                  if (e.key === "Escape") setNoting(false);
                }}
                rows={3}
                placeholder="Anotação sobre o atendimento..."
                className="w-full resize-none rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setNoting(false)} className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-ink hover:bg-gray-200">Cancelar</button>
                <button onClick={confirmNote} disabled={!noteText.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40">Adicionar nota</button>
              </div>
            </div>
          </div>
        )}
        {deleteTarget && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteTarget(null)}>
            <div className="w-full max-w-sm rounded-card bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold text-ink">Apagar mensagem</h2>
                <button onClick={() => setDeleteTarget(null)} className="text-ink-soft hover:text-ink"><X size={18} /></button>
              </div>
              <div className="flex flex-col gap-2">
                <button onClick={() => confirmDelete("everyone")} className="w-full rounded-lg bg-danger px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-600">Apagar para todos</button>
                <button onClick={() => confirmDelete("me")} className="w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-gray-50">Apagar para mim</button>
                <button onClick={() => setDeleteTarget(null)} className="w-full rounded-lg px-4 py-2 text-sm font-medium text-ink-soft transition hover:bg-gray-50">Cancelar</button>
              </div>
            </div>
          </div>
        )}
        {editing && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
            <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-ink">Editar mensagem</h2>
                <button onClick={() => setEditing(null)} className="text-ink-soft hover:text-ink"><X size={18} /></button>
              </div>
              <textarea
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing((s) => (s ? { ...s, text: e.target.value } : s))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                  if (e.key === "Escape") setEditing(null);
                }}
                rows={3}
                className="w-full resize-none rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setEditing(null)} className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-ink hover:bg-gray-200">Cancelar</button>
                <button onClick={saveEdit} disabled={!editing.text.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40">Salvar</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
