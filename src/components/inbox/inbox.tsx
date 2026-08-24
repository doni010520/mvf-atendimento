"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { ConversationList } from "./conversation-list";
import { ChatThread } from "./chat-thread";
import { ContactPanel } from "./contact-panel";
import { createClient } from "@/lib/supabase/client";

/** Toca um bip curto de notificação via Web Audio (sem precisar de arquivo). */
let audioCtx: AudioContext | null = null;
function playPing() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx ?? new Ctx();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  } catch {
    /* silencioso */
  }
}
import {
  sendMessage,
  sendLocationMessage,
  sendContactMessage,
  reactToMessage,
  editMessageAction,
  deleteMessageAction,
  markConversationRead,
  assignToMe,
  addInternalNote,
  sendInternalMessage,
  markMentionsRead,
  closeConversation,
  transferConversation,
  toggleMute,
  setConversationAi,
  fetchMessages,
  fetchConversationById,
  fetchConversations,
  fetchChannelStatuses,
  openDirectConversation,
  resolveDirectContact,
  getGroupInfo,
  sendTemplateMessage,
} from "@/app/(app)/atendimento/actions";
import { uploadMediaRaw } from "@/lib/upload-media";
import { CloseModal, TransferModal } from "./attendance-modals";
import { toast } from "@/components/toast";
import type { ConversationOverview, Message, Tag, Profile, Department, Channel } from "@/lib/types";

type TemplateOpt = { name: string; language: string; bodyText: string; varCount: number; channelId?: string | null };

export function Inbox({
  initialConversations,
  initialSelectedId,
  initialMessages,
  userId,
  hideAi = false,
  isAdmin = false,
  tags,
  agents,
  departments,
  channels,
  quickReplies,
  templates,
  live,
}: {
  initialConversations: ConversationOverview[];
  initialSelectedId: string | null;
  initialMessages: Message[];
  userId: string | null;
  hideAi?: boolean;
  isAdmin?: boolean;
  tags: Tag[];
  agents: Profile[];
  departments: Department[];
  channels?: Channel[];
  quickReplies?: { title: string; content: string; shortcut: string | null }[];
  templates?: TemplateOpt[];
  live: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState(initialConversations);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, Message[]>>(
    initialSelectedId ? { [initialSelectedId]: initialMessages } : {},
  );
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Message | null>(null);
  // Conversa-rascunho transitória (ao clicar num participante): só persiste ao digitar/enviar.
  const [draft, setDraft] = useState<ConversationOverview | null>(null);
  const [draftRealId, setDraftRealId] = useState<string | null>(null);
  // Conversa aberta por deep-link (?c=…) que NÃO está na lista carregada —
  // ex.: atendimento antigo do histórico do contato (a lista respeita a
  // visibilidade por atendente, mas ler o histórico do cliente é permitido).
  // Vive fora de `conversations` para o polling não a apagar.
  const [extraConv, setExtraConv] = useState<ConversationOverview | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [noting, setNoting] = useState(false);
  const [noteText, setNoteText] = useState("");
  // Modal "novo atendimento" (outbound).
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [ncChannel, setNcChannel] = useState("");
  const [ncPhone, setNcPhone] = useState("");
  const [ncName, setNcName] = useState("");
  const [groupParticipants, setGroupParticipants] = useState<{ name: string; phone: string }[]>([]);
  // Mensagem do grupo que será citada como quote na conversa privada (reply private).
  const [privateReplyMsg, setPrivateReplyMsg] = useState<Message | null>(null);
  // Status dos canais (para banner de desconectado).
  const [disconnectedChannels, setDisconnectedChannels] = useState<{ id: string; name: string }[]>([]);
  const DRAFT_ID = "__draft__";

  // Notificação sonora: guarda o timestamp da mensagem recebida mais recente já "ouvida".
  const maxInbound = (convs: ConversationOverview[]) =>
    convs.reduce((mx, c) => {
      if (c.last_message_direction === "in" && !c.is_muted && c.last_message_at) {
        const t = Date.parse(c.last_message_at);
        if (t > mx) return t;
      }
      return mx;
    }, 0);
  const lastPingRef = useRef<number>(maxInbound(initialConversations));

  function maybePing(convs: ConversationOverview[]) {
    const newest = maxInbound(convs);
    if (lastPingRef.current && newest > lastPingRef.current) playPing();
    if (newest > lastPingRef.current) lastPingRef.current = newest;
  }

  const selected =
    conversations.find((c) => c.id === selectedId) ??
    (extraConv && extraConv.id === selectedId ? extraConv : null) ??
    (selectedId === DRAFT_ID ? draft : null);
  const messages = selectedId ? messagesByConv[selectedId] ?? [] : [];
  // Distingue "fetch das mensagens ainda não voltou" (chave ausente) de
  // "conversa realmente vazia" ([]): o modo-template do canal oficial precisa
  // aparecer JÁ na conversa nova (caso Tainá — last_message_at vem preenchido
  // na criação e a heurística antiga achava que estava "carregando").
  const messagesLoaded = !!selectedId && messagesByConv[selectedId] != null;

  // Carrega mensagens ao selecionar (se ainda não estiverem em cache) e marca como lida.
  async function selectConversation(id: string) {
    setSelectedId(id);
    // Limpa reply-private quando o usuário muda de conversa manualmente
    setPrivateReplyMsg(null);
    // Fora da lista (deep-link do histórico p/ atendimento antigo)? Busca avulsa.
    if (id !== DRAFT_ID && !conversations.some((c) => c.id === id)) {
      fetchConversationById(id)
        .then((conv) => { if (conv) setExtraConv(conv as ConversationOverview); })
        .catch(() => {});
    }
    if (!messagesByConv[id]) {
      const msgs = await fetchMessages(id);
      setMessagesByConv((prev) => ({ ...prev, [id]: msgs }));
    }
    if (live) markConversationRead(id).catch(() => {});
    if (live) markMentionsRead(id).catch(() => {});
    // Se grupo, carrega participantes reais para menções.
    const conv = conversations.find((c) => c.id === id);
    if (conv?.is_group) {
      getGroupInfo(id).then((g) => {
        if (g?.participants) {
          setGroupParticipants(g.participants.map((p) => ({ name: p.name ?? p.phone, phone: p.phone })));
        }
      }).catch(() => {});
    } else {
      setGroupParticipants([]);
    }
  }

  // Deep-link: ?c=<convId> (ex.: clicar numa menção no sino) seleciona a conversa.
  useEffect(() => {
    const c = searchParams.get("c");
    if (c && c !== selectedId) selectConversation(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Polling da lista de conversas a cada 10s + status dos canais a cada ~30s.
  // Realtime já entrega mensagens novas na hora; este polling é backstop para a
  // ORDENAÇÃO/última msg da lista. Pausa com a aba oculta (o handler de
  // visibilitychange abaixo atualiza ao voltar o foco) — economiza Disk IO.
  useEffect(() => {
    if (!live) return;
    let cancel = false;
    let channelTick = 0;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const convs = await fetchConversations();
        if (!cancel && Array.isArray(convs)) {
          setConversations(convs);
          maybePing(convs);
        }
      } catch { /* silencioso */ }
      // Checa canais a cada ~30s (3 ticks × 10s)
      if (channelTick++ % 3 === 0) {
        try {
          const chs = await fetchChannelStatuses();
          if (!cancel) setDisconnectedChannels(chs.filter((c) => c.status !== "connected"));
        } catch { /* silencioso */ }
      }
    };
    tick();
    const t = setInterval(tick, 10000);
    return () => { cancel = true; clearInterval(t); };
  }, [live]);

  // Ao voltar o foco na aba (atendente deixou em segundo plano), atualiza na
  // hora — navegadores estrangulam timers/WebSocket em abas ocultas, o que
  // fazia parecer que "precisa dar F5" pra ver mensagens novas.
  useEffect(() => {
    if (!live) return;
    const onVisible = () => {
      if (document.hidden) return;
      fetchConversations().then((c) => Array.isArray(c) && setConversations(c)).catch(() => {});
      if (selectedId) fetchMessages(selectedId).then((m) => setMessagesByConv((prev) => ({ ...prev, [selectedId]: m }))).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [live, selectedId]);

  // Polling de mensagens da conversa aberta a cada 8s (backstop do realtime,
  // pega status entregue/lido, edições e apagadas). Pausa com a aba oculta.
  useEffect(() => {
    if (!live || !selectedId) return;
    let cancel = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const msgs = await fetchMessages(selectedId);
        if (!cancel) {
          setMessagesByConv((prev) => {
            const cur = prev[selectedId] ?? [];
            const lastCur = cur[cur.length - 1];
            const lastNew = msgs[msgs.length - 1];
            if (cur.length === msgs.length && lastCur?.id === lastNew?.id && lastCur?.status === lastNew?.status) return prev;
            return { ...prev, [selectedId]: msgs };
          });
        }
      } catch (e) {
        console.warn("[poll:msgs]", e);
      }
    };
    tick();
    const t = setInterval(tick, 8000);
    return () => { cancel = true; clearInterval(t); };
  }, [live, selectedId]);

  // Realtime: mensagens recebidas (apenas direção "in"; as enviadas são otimistas).
  useEffect(() => {
    if (!live) return;
    const supabase = createClient();
    const channel = supabase
      .channel("inbox-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const m = payload.new as Message;

          setMessagesByConv((prev) => {
            const list = prev[m.conversation_id];
            if (!list) return prev;
            // Evita duplicar mensagens já presentes (ex.: otimista app-enviada).
            if (list.some((x) => x.id === m.id || (m.external_id && x.external_id === m.external_id))) return prev;
            return { ...prev, [m.conversation_id]: [...list, m] };
          });

          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.id === m.conversation_id);
            if (idx < 0) {
              router.refresh();
              return prev;
            }
            const updated: ConversationOverview = {
              ...prev[idx],
              last_message_body: m.body,
              last_message_at: m.created_at,
              last_message_direction: m.direction,
              last_message_author: m.author_name ?? null,
            };
            return [updated, ...prev.filter((_, i) => i !== idx)];
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages" },
        (payload) => {
          const m = payload.new as Message;
          setMessagesByConv((prev) =>
            prev[m.conversation_id]
              ? { ...prev, [m.conversation_id]: prev[m.conversation_id].map((x) => (x.id === m.id ? { ...x, ...m } : x)) }
              : prev,
          );
        },
      )
      .subscribe((status) => {
        // Se o canal cair (rede/token expirado), re-sincroniza pelo polling na
        // hora — evita ficar "surdo" sem perceber (o "precisa dar F5").
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          fetchConversations().then((c) => Array.isArray(c) && setConversations(c)).catch(() => {});
        }
      });

    // Mantém o WebSocket do realtime AUTENTICADO quando o token do navegador é
    // renovado (~a cada 1h). Sem isto, depois de um tempo o realtime para de
    // entregar mensagens novas sem erro visível — a causa clássica do "só vejo
    // mensagem nova dando F5".
    const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "TOKEN_REFRESHED" || event === "SIGNED_IN") && session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
    });

    return () => {
      authSub.subscription.unsubscribe();
      supabase.removeChannel(channel);
    };
  }, [live, router]);

  function refetch(convId: string) {
    return fetchMessages(convId).then((msgs) => setMessagesByConv((prev) => ({ ...prev, [convId]: msgs })));
  }

  function handleSendLocation() {
    if (!selectedId) return;
    const convId = selectedId;
    if (!navigator.geolocation) {
      alert("Geolocalização não disponível neste dispositivo.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        startTransition(async () => {
          await sendLocationMessage(convId, { latitude: pos.coords.latitude, longitude: pos.coords.longitude });
          await refetch(convId);
        });
      },
      () => alert("Não foi possível obter a localização."),
    );
  }

  function handleSendContact() {
    if (!selectedId) return;
    const convId = selectedId;
    const name = window.prompt("Nome do contato:");
    if (!name) return;
    const phone = window.prompt("Telefone (com DDI+DDD, só números):");
    if (!phone) return;
    startTransition(async () => {
      await sendContactMessage(convId, name, phone);
      await refetch(convId);
    });
  }

  function handleOpenDirect(m: Message) {
    if (!selected) return;
    startDirect(selected, { phone: m.author_phone ?? undefined, lid: m.author_lid ?? undefined, name: m.author_name ?? undefined });
  }

  /** "Responder no privado": abre o 1:1 com a mensagem do grupo como citação pré-preenchida. */
  function handleReplyPrivate(m: Message) {
    if (!selected) return;
    setPrivateReplyMsg(m);
    startDirect(selected, { phone: m.author_phone ?? undefined, lid: m.author_lid ?? undefined, name: m.author_name ?? undefined });
  }

  function handleOpenContact(phone: string, name?: string) {
    if (!selected) return;
    startDirect(selected, { phone, name });
  }

  function startDirect(grp: ConversationOverview, opts: { phone?: string; lid?: string; name?: string }) {
    startTransition(async () => {
      const r = await resolveDirectContact(grp.channel_id, {
        ...opts,
        groupJid: grp.contact_jid ?? undefined,
      });
      if (!r.phone) {
        alert("Não consegui identificar o número deste participante.");
        return;
      }
      // Já existe conversa? Abre a real.
      if (r.existingId) {
        const convs = await fetchConversations();
        setConversations(convs);
        setSelectedId(r.existingId);
        const msgs = await fetchMessages(r.existingId);
        setMessagesByConv((prev) => ({ ...prev, [r.existingId!]: msgs }));
        return;
      }
      // Conversa-rascunho TRANSITÓRIA (não persiste até digitar/enviar).
      setDraft({
        ...grp,
        id: DRAFT_ID,
        contact_id: "",
        contact_name: r.name,
        contact_phone: r.phone,
        contact_avatar: null,
        is_group: false,
        contact_jid: null,
        status: "open",
        last_message_at: null,
        last_message_body: null,
        last_message_direction: null,
        last_message_author: null,
      });
      setDraftRealId(null);
      setMessagesByConv((prev) => ({ ...prev, [DRAFT_ID]: [] }));
      setSelectedId(DRAFT_ID);
    });
  }

  // Cria de fato a conversa do rascunho (ao digitar ou enviar). Retorna o id real.
  async function materializeDraft(): Promise<string | null> {
    if (!draft) return null;
    if (draftRealId) return draftRealId;
    const { id } = await openDirectConversation(draft.channel_id, {
      phone: draft.contact_phone,
      name: draft.contact_name ?? undefined,
    });
    if (id) {
      setDraftRealId(id);
      const convs = await fetchConversations();
      setConversations(convs);
    }
    return id;
  }

  function handleDraftType() {
    if (selectedId === DRAFT_ID && !draftRealId) {
      startTransition(async () => {
        await materializeDraft();
      });
    }
  }

  function handleReact(m: Message, emoji: string) {
    if (!selectedId) return;
    const convId = selectedId;
    startTransition(async () => {
      await reactToMessage(convId, m.id, emoji);
      const msgs = await fetchMessages(convId);
      setMessagesByConv((prev) => ({ ...prev, [convId]: msgs }));
    });
  }

  function handleEdit(m: Message) {
    setEditing({ id: m.id, text: m.body ?? "" });
  }

  function saveEdit() {
    if (!selectedId || !editing) return;
    const convId = selectedId;
    const { id, text } = editing;
    setEditing(null);
    startTransition(async () => {
      const r = await editMessageAction(convId, id, text);
      // O resultado importa: se o WhatsApp do cliente recusou, a mensagem NÃO
      // foi editada lá — dizer o contrário faria o atendente seguir confiante.
      if (r?.ok) toast("Mensagem editada também no WhatsApp do cliente.");
      else toast(r?.error ?? "Não foi possível editar a mensagem.", "error");
      const msgs = await fetchMessages(convId);
      setMessagesByConv((prev) => ({ ...prev, [convId]: msgs }));
    });
  }

  // Abre o modal próprio (centralizado) em vez do confirm() nativo do navegador.
  function handleDelete(m: Message) {
    if (!selectedId) return;
    setDeleteTarget(m);
  }

  function confirmDelete(scope: "me" | "everyone") {
    const m = deleteTarget;
    setDeleteTarget(null);
    if (!m || !selectedId) return;
    const convId = selectedId;
    startTransition(async () => {
      const r = await deleteMessageAction(convId, m.id, scope);
      if (r?.ok) {
        toast(scope === "everyone" ? "Mensagem apagada no WhatsApp do cliente." : "Mensagem apagada aqui (o cliente continua vendo).");
      } else {
        toast(`${r?.error ?? "Não foi possível apagar."} Se quiser tirar só da tela, use "Apagar para mim".`, "error");
      }
      const msgs = await fetchMessages(convId);
      setMessagesByConv((prev) => ({ ...prev, [convId]: msgs }));
    });
  }

  function handleSend(text: string, replyId?: string, mentions?: { name: string; phone: string }[]) {
    if (!selectedId) return;

    // "Responder no privado": a mensagem do grupo não pode ser citada via replyId
    // (cross-chat), então prefixamos o texto com a citação e enviamos sem replyId.
    let finalText = text;
    let finalReplyId = replyId;
    if (privateReplyMsg && replyId === privateReplyMsg.external_id) {
      const author = privateReplyMsg.author_name ?? "Participante";
      const excerpt = (privateReplyMsg.body ?? `[${privateReplyMsg.content_type}]`).slice(0, 200);
      finalText = `> *${author}:*\n> ${excerpt.split("\n").join("\n> ")}\n\n${text}`;
      finalReplyId = undefined;
      setPrivateReplyMsg(null);
    }

    // Rascunho: cria a conversa de verdade agora e envia nela.
    if (selectedId === DRAFT_ID) {
      startTransition(async () => {
        const realId = await materializeDraft();
        if (!realId) return;
        await sendMessage(realId, finalText, finalReplyId, mentions);
        const convs = await fetchConversations();
        setConversations(convs);
        setSelectedId(realId);
        const msgs = await fetchMessages(realId);
        setMessagesByConv((prev) => ({ ...prev, [realId]: msgs }));
        setDraft(null);
        setDraftRealId(null);
      });
      return;
    }
    const optimistic: Message = {
      id: `tmp-${Date.now()}`,
      organization_id: "",
      conversation_id: selectedId,
      direction: "out",
      sender_type: "agent",
      sender_id: userId,
      content_type: "text",
      body: finalText,
      media_url: null,
      status: "pending",
      external_id: null,
      created_at: new Date().toISOString(),
    };
    setMessagesByConv((prev) => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] ?? []), optimistic],
    }));
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === selectedId);
      if (idx < 0) return prev;
      const updated = { ...prev[idx], last_message_body: finalText, last_message_at: optimistic.created_at, last_message_direction: "out" as const };
      return [updated, ...prev.filter((_, i) => i !== idx)];
    });

    startTransition(async () => {
      const r = await sendMessage(selectedId, finalText, finalReplyId, mentions);
      if (r && r.ok === false) toast(r.error ?? "Mensagem não entregue.", "error");
      if (live) {
        const msgs = await fetchMessages(selectedId);
        setMessagesByConv((prev) => ({ ...prev, [selectedId]: msgs }));
      }
    });
  }

  function handleSendInternal(text: string, mentions: { id: string; name: string }[]) {
    if (!selectedId || selectedId === DRAFT_ID) return;
    const convId = selectedId;
    const myName = agents.find((a) => a.id === userId)?.name ?? "Você";
    const optimistic: Message = {
      id: `tmp-int-${Date.now()}`,
      organization_id: "",
      conversation_id: convId,
      direction: "out",
      sender_type: "agent",
      sender_id: userId,
      content_type: "text",
      body: text,
      media_url: null,
      status: "sent",
      external_id: null,
      is_internal: true,
      author_name: myName,
      mentions,
      created_at: new Date().toISOString(),
    };
    setMessagesByConv((prev) => ({ ...prev, [convId]: [...(prev[convId] ?? []), optimistic] }));
    startTransition(async () => {
      await sendInternalMessage(convId, text, mentions);
      if (live) {
        const msgs = await fetchMessages(convId);
        setMessagesByConv((prev) => ({ ...prev, [convId]: msgs }));
      }
    });
  }

  function handleSendTemplate(name: string, language: string, params: string[]) {
    if (!selectedId || selectedId === DRAFT_ID) return;
    const convId = selectedId;
    startTransition(async () => {
      const r = await sendTemplateMessage(convId, name, language, params);
      if (r?.ok) toast("Modelo enviado.");
      else toast(r?.error ?? "Falha ao enviar o modelo.", "error");
      const msgs = await fetchMessages(convId);
      setMessagesByConv((prev) => ({ ...prev, [convId]: msgs }));
    });
  }

  function handleSendFile(file: File, asSticker?: boolean) {
    if (!selectedId) return;
    const convId = selectedId;
    startTransition(async () => {
      // Envio FORA de server action: corpo CRU + metadados na query (o caminho
      // multipart→action falhava por teto/parser e travava sem timeout).
      const res = await uploadMediaRaw(convId, file, asSticker);
      // Falha ao preparar/enviar (ex.: conversão de áudio) precisa aparecer —
      // antes o erro era silencioso e o atendente achava que tinha enviado.
      if (res && res.ok === false && res.error) alert(res.error);
      const msgs = await fetchMessages(convId);
      setMessagesByConv((prev) => ({ ...prev, [convId]: msgs }));
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === convId);
        if (idx < 0) return prev;
        const ml: Record<string, string> = { "image/": "📷 Foto", "video/": "🎥 Vídeo", "audio/": "🎵 Áudio" };
        const mediaPreview = Object.entries(ml).find(([k]) => file.type.startsWith(k))?.[1] ?? "📄 Documento";
        const cap = (file as File & { caption?: string }).caption;
        const updated = { ...prev[idx], last_message_body: cap || mediaPreview, last_message_at: new Date().toISOString(), last_message_direction: "out" as const };
        return [updated, ...prev.filter((_, i) => i !== idx)];
      });
    });
  }

  function handleAssign() {
    if (!selectedId) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedId ? { ...c, status: "open", assigned_user_id: userId } : c)),
    );
    startTransition(() => assignToMe(selectedId));
  }

  function handleClose() {
    if (!selectedId || selectedId === DRAFT_ID) return;
    setClosing(true);
  }

  function confirmClose(opts: { reason: string; solution: string; forwardings: string; pending: string; tagIds: string[]; sendSurvey: boolean }) {
    if (!selectedId) return;
    const id = selectedId;
    setClosing(false);
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, status: "closed" } : c)));
    startTransition(async () => {
      await closeConversation(id, opts);
      await refetch(id);
    });
  }

  function handleTransfer() {
    if (!selectedId || selectedId === DRAFT_ID) return;
    setTransferring(true);
  }

  function handleAddNote() {
    if (!selectedId || selectedId === DRAFT_ID) return;
    setNoteText("");
    setNoting(true);
  }

  function openNewConversation() {
    const list = channels ?? [];
    setNcChannel(list[0]?.id ?? "");
    setNcPhone("");
    setNcName("");
    setNewConvOpen(true);
  }

  function confirmNewConversation() {
    const phone = ncPhone.replace(/\D/g, "");
    if (!ncChannel || !phone) return;
    setNewConvOpen(false);
    startTransition(async () => {
      const { id } = await openDirectConversation(ncChannel, { phone, name: ncName.trim() || undefined });
      if (!id) {
        alert("Não foi possível abrir o atendimento.");
        return;
      }
      const convs = await fetchConversations();
      setConversations(convs);
      setSelectedId(id);
      const msgs = await fetchMessages(id);
      setMessagesByConv((prev) => ({ ...prev, [id]: msgs }));
    });
  }

  function confirmNote() {
    if (!selectedId) return;
    const id = selectedId;
    const text = noteText.trim();
    if (!text) return;
    setNoting(false);
    startTransition(async () => {
      await addInternalNote(id, text);
      await refetch(id);
    });
  }

  function confirmTransfer(opts: {
    toUserId: string | null;
    toUserIds: string[];
    toDepartmentId: string | null;
    internalNote: string;
    customerMessage: string;
  }) {
    if (!selectedId) return;
    const id = selectedId;
    setTransferring(false);
    startTransition(async () => {
      await transferConversation(id, opts);
      const convs = await fetchConversations();
      setConversations(convs);
      await refetch(id);
    });
  }

  function handleToggleMute() {
    if (!selectedId) return;
    const next = !selected?.is_muted;
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedId ? { ...c, is_muted: next } : c)),
    );
    startTransition(() => toggleMute(selectedId, next).then(() => undefined));
  }

  function handleToggleAi() {
    if (!selectedId || selectedId === DRAFT_ID) return;
    // "IA conduzindo" = ai_enabled e status bot. Se está conduzindo → pausa (false);
    // se é humano atendendo (open) → devolve para a IA (true).
    const aiHandling = selected?.ai_enabled !== false && selected?.status === "bot";
    const next = !aiHandling;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === selectedId
          ? { ...c, ai_enabled: next, status: next ? "bot" : "open", assigned_user_id: next ? c.assigned_user_id : userId }
          : c,
      ),
    );
    startTransition(async () => {
      await setConversationAi(selectedId, next);
      await refetch(selectedId);
    });
  }

  // Atalho da lista: pausa a IA de uma conversa sem precisar abri-la.
  function handlePauseAiQuick(id: string) {
    if (id === DRAFT_ID) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ai_enabled: false, status: "open", assigned_user_id: userId } : c)),
    );
    startTransition(async () => {
      await setConversationAi(id, false);
      if (id === selectedId) await refetch(id);
    });
  }

  // Conversas filtradas: esconde as de canais desconectados e, para ATENDENTE
  // (não-admin), esconde as atribuídas a OUTRO atendente — só as não-atribuídas
  // (fila/bot) e as dele. Blindagem no client (o servidor já filtra em getConversations).
  const disconnectedIds = new Set(disconnectedChannels.map((c) => c.id));
  let visibleConversations = disconnectedIds.size > 0
    ? conversations.filter((c) => !disconnectedIds.has(c.channel_id))
    : conversations;
  if (!isAdmin) {
    // Encerrada é histórico (visível p/ todos — "Ver conversa" do painel); o
    // filtro por dono vale só para conversas ativas.
    visibleConversations = visibleConversations.filter(
      (c) => c.status === "closed" || !c.assigned_user_id || c.assigned_user_id === userId,
    );
  }
  const allDisconnected = disconnectedChannels.length > 0 && visibleConversations.length === 0 && conversations.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Banner de canais desconectados */}
      {disconnectedChannels.length > 0 && (
        <div className={`flex items-center gap-2 px-4 py-2 text-sm ${allDisconnected ? "bg-red-500 text-white" : "bg-amber-50 text-amber-800 border-b border-amber-100"}`}>
          <span className="text-lg">{allDisconnected ? "🔌" : "⚠️"}</span>
          <span className="flex-1">
            {allDisconnected
              ? "Todos os números estão desconectados. Acesse Canais para reconectar."
              : `${disconnectedChannels.length} canal(is) desconectado(s): ${disconnectedChannels.map((c) => c.name).join(", ")}`}
          </span>
          <a href="/canais" className={`shrink-0 rounded-lg px-3 py-1 text-xs font-medium ${allDisconnected ? "bg-white text-red-600 hover:bg-red-50" : "bg-amber-100 text-amber-800 hover:bg-amber-200"}`}>
            Reconectar
          </a>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
      {/* Com conversa aberta, a lista some abaixo de lg para o painel de contato
          caber dockado (chat + painel). Em lg+ mostra lista + chat + painel. */}
      <div className={`${selectedId ? "hidden lg:flex" : "flex"} h-full w-full lg:w-auto`}>
        <ConversationList
          conversations={visibleConversations}
          selectedId={selectedId}
          onSelect={selectConversation}
          onPauseAi={handlePauseAiQuick}
          onNewConversation={(channels?.length ?? 0) > 0 ? openNewConversation : undefined}
          userId={userId}
        />
      </div>
      {selected ? (
        <ChatThread
          onBack={() => setSelectedId(null)}
          conversation={selected}
          messages={messages}
          messagesLoaded={messagesLoaded}
          groupParticipants={groupParticipants}
          onSend={handleSend}
          onSendInternal={handleSendInternal}
          agents={agents.map((a) => ({ id: a.id, name: a.name ?? "Atendente", avatar_url: a.avatar_url }))}
          currentUserId={userId}
          hideAi={hideAi}
          isAdmin={isAdmin}
          onSendFile={handleSendFile}
          onSendLocation={handleSendLocation}
          onSendContact={handleSendContact}
          onReact={handleReact}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onAuthorClick={handleOpenDirect}
          onReplyPrivate={selected.is_group ? handleReplyPrivate : undefined}
          onOpenPanel={() => setPanelOpen(true)}
          onType={handleDraftType}
          onAssign={handleAssign}
          onClose={handleClose}
          onTransfer={handleTransfer}
          onAddNote={handleAddNote}
          onToggleMute={handleToggleMute}
          onToggleAi={handleToggleAi}
          initialReplyTo={!selected.is_group && privateReplyMsg ? privateReplyMsg : undefined}
          quickReplies={quickReplies}
          templates={templates}
          onSendTemplate={handleSendTemplate}
          pending={isPending}
        />
      ) : (
        <div className="hidden flex-1 items-center justify-center text-sm text-ink-soft md:flex">
          Selecione uma conversa para começar.
        </div>
      )}

      {selected && (
        <>
          {/* Backdrop apenas no modo gaveta (abaixo de md = celular), quando aberta. */}
          {panelOpen && (
            <div
              className="fixed inset-0 z-40 bg-black/40 md:hidden"
              onClick={() => setPanelOpen(false)}
            />
          )}
          {/*
            md+: coluna fixa (dockada), SEMPRE visível ao LADO da conversa — reflui o chat.
            < md (celular): gaveta que desliza da direita, só quando panelOpen.
          */}
          <div
            className={
              "shrink-0 transition-transform duration-200 " +
              "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:shadow-2xl " +
              (panelOpen ? "max-md:translate-x-0" : "max-md:translate-x-full") +
              " md:static md:z-auto md:translate-x-0 md:shadow-none"
            }
          >
            <ContactPanel
              key={selected.id}
              conversation={selected}
              onClose={() => setPanelOpen(false)}
              onOpenContact={handleOpenContact}
            />
          </div>
        </>
      )}

      {closing && selected && (
        <CloseModal
          tags={tags}
          protocol={selected.protocol}
          onConfirm={confirmClose}
          onCancel={() => setClosing(false)}
          pending={isPending}
        />
      )}

      {transferring && selected && (
        <TransferModal
          agents={agents}
          departments={departments}
          currentUserId={userId}
          onConfirm={confirmTransfer}
          onCancel={() => setTransferring(false)}
          pending={isPending}
        />
      )}

      {newConvOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setNewConvOpen(false)}>
          <div className="w-full max-w-md rounded-card bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink">Novo atendimento</h2>
              <button onClick={() => setNewConvOpen(false)} className="text-ink-soft hover:text-ink"><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-soft">Canal</label>
                <select
                  value={ncChannel}
                  onChange={(e) => setNcChannel(e.target.value)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand"
                >
                  {(channels ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-soft">Telefone (com DDI+DDD, só números)</label>
                <input
                  value={ncPhone}
                  onChange={(e) => setNcPhone(e.target.value)}
                  placeholder="5573999998888"
                  inputMode="numeric"
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-soft">Nome (opcional)</label>
                <input
                  value={ncName}
                  onChange={(e) => setNcName(e.target.value)}
                  placeholder="Nome do contato"
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
              {(channels ?? []).find((c) => c.id === ncChannel)?.type === "meta_cloud" && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  Canal Meta oficial: fora da janela de 24h, só mensagens de template (HSM) são entregues.
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setNewConvOpen(false)} className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-ink hover:bg-gray-200">
                Cancelar
              </button>
              <button onClick={confirmNewConversation} disabled={!ncChannel || !ncPhone.replace(/\D/g, "")} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40">
                Abrir atendimento
              </button>
            </div>
          </div>
        </div>
      )}

      {noting && selected && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setNoting(false)}>
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
              <button onClick={() => setNoting(false)} className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-ink hover:bg-gray-200">
                Cancelar
              </button>
              <button onClick={confirmNote} disabled={!noteText.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40">
                Adicionar nota
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="w-full max-w-sm rounded-card bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink">Apagar mensagem</h2>
              <button onClick={() => setDeleteTarget(null)} className="text-ink-soft hover:text-ink"><X size={18} /></button>
            </div>
            <div className="flex flex-col gap-2">
              {/* Duas restrições reais:
                  1) "Para todos" só faz sentido em mensagem NOSSA — o WhatsApp não deixa
                     ninguém apagar mensagem do aparelho do outro (falhava sempre);
                  2) na API Oficial (Meta) não existe revogar — ali só dá para tirar da
                     conversa da equipe, e o texto abaixo diz isso com todas as letras. */}
              {selected?.channel_type === "meta_cloud" ? (
                <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-ink-soft">
                  Esta conversa é da <strong>API Oficial</strong>, que não permite apagar a mensagem
                  do WhatsApp do cliente. Você pode tirá-la da conversa da equipe — ela fica no
                  histórico para auditoria, mas <strong>o cliente continua vendo</strong>.
                </p>
              ) : deleteTarget.direction === "out" ? (
                <button
                  onClick={() => confirmDelete("everyone")}
                  className="w-full rounded-lg bg-danger px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-600"
                >
                  Apagar para todos
                </button>
              ) : (
                <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-ink-soft">
                  Esta mensagem é do cliente — o WhatsApp não permite apagá-la do aparelho dele.
                  Dá para tirar só daqui.
                </p>
              )}
              <button
                onClick={() => confirmDelete("me")}
                className="w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-gray-50"
              >
                Apagar para mim
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                className="w-full rounded-lg px-4 py-2 text-sm font-medium text-ink-soft transition hover:bg-gray-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
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
              <button onClick={() => setEditing(null)} className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-ink hover:bg-gray-200">
                Cancelar
              </button>
              <button onClick={saveEdit} disabled={!editing.text.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40">
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
