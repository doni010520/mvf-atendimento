"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Paperclip, Mic, Loader2, MapPin, UserPlus, FileUp, Smile, Sticker, X, Image as ImageIcon, FileText, LayoutTemplate, MessageCircle, Lock, Trash2 } from "lucide-react";
import { EmojiPicker } from "./emoji-picker";

type Mention = { name: string; phone: string };
type AgentMention = { id: string; name: string };
type QuickReply = { title: string; content: string; shortcut: string | null };
type Template = { name: string; language: string; bodyText: string; varCount: number; channelId?: string | null };

export function Composer({
  onSend,
  onSendInternal,
  agentCandidates,
  onSendFile,
  onSendLocation,
  onSendContact,
  onType,
  mentionCandidates,
  quickReplies,
  windowOpen = true,
  isMeta = false,
  templates,
  channelId,
  onSendTemplate,
  disabled,
  sending,
  focusTrigger,
}: {
  onSend: (text: string, mentions?: Mention[]) => void;
  onSendInternal?: (text: string, mentions: AgentMention[]) => void;
  agentCandidates?: AgentMention[];
  onSendFile: (file: File, asSticker?: boolean) => void;
  onSendLocation?: () => void;
  onSendContact?: () => void;
  onType?: () => void;
  mentionCandidates?: Mention[];
  quickReplies?: QuickReply[];
  windowOpen?: boolean;
  isMeta?: boolean;
  templates?: Template[];
  channelId?: string | null;
  onSendTemplate?: (name: string, language: string, params: string[]) => void;
  disabled?: boolean;
  sending?: boolean;
  focusTrigger?: unknown;
}) {
  // Modo do composer: responder o cliente ("reply") ou mensagem interna da equipe.
  const [mode, setMode] = useState<"reply" | "internal">("reply");
  const internalMode = mode === "internal";
  const allowInternal = !!onSendInternal;
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrQuery, setQrQuery] = useState("");
  // Modo template (Meta fora da janela de 24h).
  const [tplPick, setTplPick] = useState<Template | null>(null);
  // Templates são POR canal/WABA (cada número tem os seus). Mostra só os do
  // canal desta conversa — mais os sem canal (cadastrados manualmente/globais).
  const visibleTemplates = useMemo(
    () => (templates ?? []).filter((t) => t.channelId == null || t.channelId === channelId),
    [templates, channelId],
  );
  const [tplParams, setTplParams] = useState<string[]>([]);

  // Foco automático ao mudar focusTrigger (ex.: clicar Responder).
  useEffect(() => { if (focusTrigger != null) taRef.current?.focus(); }, [focusTrigger]);

  const [attachMenu, setAttachMenu] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [agentMentions, setAgentMentions] = useState<AgentMention[]>([]);

  // Preview de mídia antes de enviar (modal estilo WhatsApp Web).
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingCaption, setPendingCaption] = useState("");
  const [pendingSticker, setPendingSticker] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const captionRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stickerRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const cancelRecRef = useRef(false); // true = descartar o áudio no stop (não enviar)
  const chunksRef = useRef<Blob[]>([]);

  // Candidatos de menção, normalizados para { name, key }. No modo interno são os
  // atendentes (key = id); no modo cliente são contatos do grupo (key = telefone).
  const candidates: { name: string; key: string }[] = internalMode
    ? (agentCandidates ?? []).map((a) => ({ name: a.name, key: a.id }))
    : (mentionCandidates ?? []).map((c) => ({ name: c.name, key: c.phone }));
  const filtered =
    mentionQuery != null && candidates.length
      ? candidates.filter((c) => c.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
      : [];

  // Preview URL da mídia pendente.
  const previewUrl = useMemo(
    () => (pendingFile ? URL.createObjectURL(pendingFile) : null),
    [pendingFile],
  );
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // Foco no campo de legenda quando o modal abre.
  useEffect(() => { if (pendingFile) captionRef.current?.focus(); }, [pendingFile]);

  function stageFile(file: File, asSticker = false) {
    setPendingFile(file);
    setPendingCaption("");
    setPendingSticker(asSticker);
  }

  function confirmSend() {
    if (!pendingFile) return;
    // Se tem legenda, precisa enviar como FormData com caption — o onSendFile atual
    // não suporta caption; vamos passar o arquivo e a caption vai no body do sendMediaMessage.
    // Workaround: renomeia o arquivo adicionando a caption como propriedade custom.
    // Na verdade, o fluxo sendMediaMessage já lê "caption" do FormData — mas onSendFile(file)
    // é chamado sem caption. Vou criar um File com caption embutida no name? Não, melhor:
    // o inbox.tsx que chama handleSendFile monta o FormData. Vou passar via um hack limpo:
    // extendo File com propriedade caption.
    const f = pendingFile as File & { caption?: string };
    if (pendingCaption.trim()) {
      Object.defineProperty(f, "caption", { value: pendingCaption.trim(), writable: true });
    }
    onSendFile(f, pendingSticker);
    setPendingFile(null);
    setPendingCaption("");
  }

  function cancelPreview() {
    setPendingFile(null);
    setPendingCaption("");
  }

  function updateMentionQuery(val: string, caret: number) {
    const before = val.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]{0,30})$/);
    setMentionQuery(candidates.length && m ? m[1] : null);
  }

  function pickMention(c: { name: string; key: string }) {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    const start = m ? caret - m[1].length - 1 : caret;
    const newText = text.slice(0, start) + `@${c.name} ` + after;
    setText(newText);
    if (internalMode) {
      setAgentMentions((prev) => (prev.some((x) => x.id === c.key) ? prev : [...prev, { id: c.key, name: c.name }]));
    } else {
      setMentions((prev) => (prev.some((x) => x.phone === c.key) ? prev : [...prev, { name: c.name, phone: c.key }]));
    }
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const pos = start + c.name.length + 2;
      ta?.focus();
      ta?.setSelectionRange(pos, pos);
    });
  }

  function submit() {
    const t = text.trim();
    if (!t) return;
    if (internalMode) {
      const used = agentMentions.filter((m) => t.includes(`@${m.name}`));
      onSendInternal?.(t, used);
    } else {
      const used = mentions.filter((m) => t.includes(`@${m.name}`));
      onSend(t, used.length ? used : undefined);
    }
    setText("");
    setMentions([]);
    setAgentMentions([]);
    setMentionQuery(null);
  }

  // Insere o conteúdo de um modelo/macro no campo de texto e foca.
  function insertQuickReply(qr: QuickReply) {
    setText((t) => (t.trim() ? `${t}\n${qr.content}` : qr.content));
    setQrOpen(false);
    setQrQuery("");
    requestAnimationFrame(() => taRef.current?.focus());
  }

  const qrFiltered = (quickReplies ?? []).filter((q) => {
    if (!qrQuery.trim()) return true;
    const s = qrQuery.toLowerCase();
    return q.title.toLowerCase().includes(s) || (q.shortcut ?? "").toLowerCase().includes(s) || q.content.toLowerCase().includes(s);
  });

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) stageFile(f);
    e.target.value = "";
  }
  function pickStickerFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) stageFile(f, true);
    e.target.value = "";
  }

  async function toggleRecord() {
    if (recording) {
      // Parar e ENVIAR (botão vermelho de stop).
      cancelRecRef.current = false;
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      cancelRecRef.current = false;
      rec.ondataavailable = (ev) => ev.data.size && chunksRef.current.push(ev.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        // Cancelado → descarta o áudio e NÃO envia.
        if (cancelRecRef.current) { cancelRecRef.current = false; chunksRef.current = []; return; }
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const ext = (rec.mimeType || "audio/webm").includes("ogg") ? "ogg" : "webm";
        // Áudio gravado envia direto sem preview.
        onSendFile(new File([blob], `audio-${Date.now()}.${ext}`, { type: blob.type }));
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      alert("Não foi possível acessar o microfone.");
    }
  }

  /** Cancela a gravação em andamento: para o gravador e DESCARTA (não envia). */
  function cancelRecord() {
    if (!recording) return;
    cancelRecRef.current = true;
    recorderRef.current?.stop();
  }

  const isImage = pendingFile?.type.startsWith("image/");
  const isVideo = pendingFile?.type.startsWith("video/");

  return (
    <>
      {/* ========== Modal de preview de mídia (estilo WhatsApp Web) ========== */}
      {pendingFile && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={cancelPreview}>
          <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                <ImageIcon size={16} className="text-brand" />
                {isImage ? "Enviar imagem" : isVideo ? "Enviar vídeo" : "Enviar arquivo"}
              </div>
              <button onClick={cancelPreview} className="rounded-full p-1 text-ink-soft hover:bg-gray-100 hover:text-ink">
                <X size={18} />
              </button>
            </div>

            {/* Preview */}
            <div className="flex items-center justify-center bg-gray-900/5 p-6" style={{ minHeight: 240 }}>
              {isImage && previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl} alt="Preview" className="max-h-80 max-w-full rounded-lg object-contain" />
              ) : isVideo && previewUrl ? (
                <video src={previewUrl} controls className="max-h-80 max-w-full rounded-lg" />
              ) : (
                <div className="flex flex-col items-center gap-2 text-ink-soft">
                  <FileUp size={40} />
                  <p className="text-sm font-medium">{pendingFile.name}</p>
                  <p className="text-xs">{(pendingFile.size / 1024).toFixed(0)} KB</p>
                </div>
              )}
            </div>

            {/* Caption + enviar */}
            <div className="flex items-center gap-2 border-t border-border px-4 py-3">
              <input
                ref={captionRef}
                value={pendingCaption}
                onChange={(e) => setPendingCaption(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); confirmSend(); }
                  if (e.key === "Escape") cancelPreview();
                }}
                placeholder="Adicionar legenda..."
                className="flex-1 rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <button
                onClick={confirmSend}
                disabled={sending}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-white transition hover:bg-brand-dark disabled:opacity-40"
                title="Enviar"
              >
                {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Abas: Responder cliente | Mensagem interna ========== */}
      {allowInternal && (
        <div className="flex items-center gap-1.5 border-t border-border bg-surface px-3 pt-2">
          <button
            onClick={() => { setMode("reply"); setMentionQuery(null); }}
            title="Responder ao cliente — enviada no WhatsApp dele."
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              !internalMode ? "border-brand bg-brand text-white shadow-sm" : "border-border bg-surface text-ink-soft hover:bg-gray-50 hover:text-ink"
            }`}
          >
            <MessageCircle size={13} /> Responder cliente
          </button>
          <button
            onClick={() => { setMode("internal"); setMentionQuery(null); }}
            title="Nota interna da equipe — o cliente NÃO vê. Use @ para marcar um atendente."
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              internalMode ? "border-amber-400 bg-amber-100 text-amber-800 shadow-sm" : "border-border bg-surface text-ink-soft hover:bg-gray-50 hover:text-ink"
            }`}
          >
            <Lock size={13} /> Mensagem interna
          </button>
        </div>
      )}

      {/* ========== Barra restrita: Meta fora da janela de 24h ========== */}
      {isMeta && !windowOpen && !internalMode ? (
        <div className="border-t border-border bg-surface p-3">
          <div className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            <span>⚠️</span>
            <span>Janela de 24h encerrada (canal <b>API Oficial</b>). Só é possível enviar um <b>modelo aprovado</b> para reabrir a conversa.</span>
          </div>
          {visibleTemplates.length === 0 ? (
            <p className="text-xs text-ink-soft">
              Nenhum modelo aprovado disponível para este número. Cadastre ou sincronize em{" "}
              <a href="/mensagens/templates" className="text-brand underline">Mensagens → Templates</a>.
            </p>
          ) : !tplPick ? (
            <div className="flex flex-wrap gap-2">
              {visibleTemplates.map((t) => (
                <button
                  key={`${t.name}-${t.language}`}
                  onClick={() => { setTplPick(t); setTplParams(Array(t.varCount).fill("")); }}
                  className="flex w-60 flex-col items-start gap-0.5 rounded-lg border border-border px-2.5 py-2 text-left transition hover:border-brand"
                  title={t.name}
                >
                  <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                    <LayoutTemplate size={11} /> {t.name}
                  </span>
                  <span className="line-clamp-2 text-xs text-ink">{t.bodyText || "(modelo sem corpo de texto)"}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink">{tplPick.name} <span className="text-ink-soft">({tplPick.language})</span></span>
                <button onClick={() => setTplPick(null)} className="text-ink-soft hover:text-ink"><X size={14} /></button>
              </div>
              {tplPick.bodyText && <p className="rounded bg-canvas px-2 py-1.5 text-[11px] text-ink-soft">{tplPick.bodyText}</p>}
              {Array.from({ length: tplPick.varCount }).map((_, i) => (
                <input
                  key={i}
                  value={tplParams[i] ?? ""}
                  onChange={(e) => setTplParams((p) => { const n = [...p]; n[i] = e.target.value; return n; })}
                  placeholder={`Variável {{${i + 1}}}`}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand"
                />
              ))}
              <button
                onClick={() => { onSendTemplate?.(tplPick.name, tplPick.language, tplParams); setTplPick(null); setTplParams([]); }}
                disabled={sending || tplParams.some((p) => !p.trim())}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-40"
              >
                <Send size={15} /> Enviar modelo
              </button>
            </div>
          )}
        </div>
      ) : (
      /* ========== Composer ========== */
      <div className={`relative flex items-end gap-2 p-3 ${internalMode ? "bg-amber-50" : "bg-surface"} ${allowInternal ? "" : "border-t border-border"}`}>
        <input ref={fileRef} type="file" className="hidden" onChange={pickFile} />
        <input ref={stickerRef} type="file" accept="image/*" className="hidden" onChange={pickStickerFile} />

        {/* Dropdown de menções */}
        {filtered.length > 0 && (
          <div className="absolute bottom-16 left-3 z-30 w-64 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-xl">
            <p className="px-3 py-1 text-[10px] font-semibold uppercase text-ink-soft">Mencionar</p>
            {filtered.map((c) => (
              <button
                key={c.key}
                onClick={() => pickMention(c)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-gray-50"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-light text-[10px] font-semibold text-brand">
                  {c.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </div>
        )}

        <div className="relative">
          <button
            onClick={() => { setEmojiOpen((v) => !v); setAttachMenu(false); }}
            disabled={disabled || sending}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-gray-100 text-ink-soft transition hover:bg-gray-200 disabled:opacity-40"
            title="Emojis"
          >
            <Smile size={18} />
          </button>
          {emojiOpen && <EmojiPicker onPick={(e) => setText((t) => t + e)} onClose={() => setEmojiOpen(false)} />}
        </div>
        <div className="relative">
          <button
            onClick={() => setAttachMenu((v) => !v)}
            disabled={disabled || sending || internalMode}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-gray-100 text-ink-soft transition hover:bg-gray-200 disabled:opacity-40"
            title={internalMode ? "Anexos indisponíveis na mensagem interna" : "Anexar"}
          >
            <Paperclip size={18} />
          </button>
          {attachMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAttachMenu(false)} />
              <div className="absolute bottom-12 left-0 z-20 w-44 overflow-hidden rounded-lg border border-border bg-surface py-1 text-sm shadow-xl">
                <button onClick={() => { setAttachMenu(false); fileRef.current?.click(); }} className="flex w-full items-center gap-2 px-3 py-2 text-ink hover:bg-gray-50">
                  <FileUp size={15} /> Arquivo / mídia
                </button>
                <button onClick={() => { setAttachMenu(false); stickerRef.current?.click(); }} className="flex w-full items-center gap-2 px-3 py-2 text-ink hover:bg-gray-50">
                  <Sticker size={15} /> Figurinha
                </button>
                {onSendLocation && (
                  <button onClick={() => { setAttachMenu(false); onSendLocation(); }} className="flex w-full items-center gap-2 px-3 py-2 text-ink hover:bg-gray-50">
                    <MapPin size={15} /> Localização
                  </button>
                )}
                {onSendContact && (
                  <button onClick={() => { setAttachMenu(false); onSendContact(); }} className="flex w-full items-center gap-2 px-3 py-2 text-ink hover:bg-gray-50">
                    <UserPlus size={15} /> Contato
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {(quickReplies?.length ?? 0) > 0 && (
          <div className="relative">
            <button
              onClick={() => { setQrOpen((v) => !v); setAttachMenu(false); setEmojiOpen(false); }}
              disabled={disabled || sending}
              className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-gray-100 text-ink-soft transition hover:bg-gray-200 disabled:opacity-40"
              title="Modelos e macros"
            >
              <FileText size={18} />
            </button>
            {qrOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setQrOpen(false)} />
                <div className="absolute bottom-12 left-0 z-20 w-72 overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
                  <div className="border-b border-border p-2">
                    <input
                      autoFocus
                      value={qrQuery}
                      onChange={(e) => setQrQuery(e.target.value)}
                      placeholder="Buscar modelo ou macro..."
                      className="w-full rounded-md border border-border px-2 py-1.5 text-xs outline-none focus:border-brand"
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto py-1">
                    {qrFiltered.length === 0 && (
                      <p className="px-3 py-3 text-center text-xs text-ink-soft">Nada encontrado.</p>
                    )}
                    {qrFiltered.map((q, i) => (
                      <button
                        key={i}
                        onClick={() => insertQuickReply(q)}
                        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-gray-50"
                      >
                        <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                          {q.title}
                          {q.shortcut && <span className="rounded bg-gray-100 px-1 text-[10px] text-ink-soft">/{q.shortcut}</span>}
                        </span>
                        <span className="truncate text-[11px] text-ink-soft">{q.content}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (!text.trim() && v.trim()) onType?.();
            setText(v);
            updateMentionQuery(v, e.target.selectionStart ?? v.length);
          }}
          onClick={(e) => updateMentionQuery(text, (e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of Array.from(items)) {
              if (item.type.startsWith("image/") || item.type.startsWith("video/")) {
                e.preventDefault();
                const blob = item.getAsFile();
                if (blob) {
                  const ext = item.type.split("/")[1] ?? "png";
                  stageFile(new File([blob], `paste-${Date.now()}.${ext}`, { type: item.type }));
                }
                return;
              }
            }
          }}
          onDrop={(e) => {
            const files = e.dataTransfer?.files;
            if (files?.length) {
              e.preventDefault();
              stageFile(files[0]);
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (filtered.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
              e.preventDefault();
              pickMention(filtered[0]);
              return;
            }
            if (e.key === "Enter" && (e.ctrlKey || e.shiftKey)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") setMentionQuery(null);
          }}
          rows={1}
          placeholder={
            recording
              ? "Gravando áudio..."
              : internalMode
                ? "Mensagem interna (o cliente não vê) — use @ para marcar um atendente"
                : "Digite uma mensagem..."
          }
          disabled={disabled || recording}
          style={{ height: "auto" }}
          onInput={(e) => {
            const ta = e.currentTarget;
            ta.style.height = "auto";
            ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
          }}
          className="min-h-[42px] max-h-[200px] flex-1 resize-none rounded-xl border border-border px-3 py-2 text-sm outline-none focus:border-brand disabled:bg-gray-50"
        />

        {text.trim() || internalMode ? (
          <button
            onClick={submit}
            disabled={disabled || sending || !text.trim()}
            className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl text-white transition disabled:opacity-40 ${
              internalMode ? "bg-amber-500 hover:bg-amber-600" : "bg-brand hover:bg-brand-dark"
            }`}
            title={internalMode ? "Enviar mensagem interna" : "Enviar"}
          >
            {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          </button>
        ) : recording ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={cancelRecord}
              disabled={disabled || sending}
              className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-danger/40 bg-danger/10 text-danger transition hover:bg-danger/20 disabled:opacity-40"
              title="Cancelar gravação (descartar)"
            >
              <Trash2 size={18} />
            </button>
            <span className="flex items-center gap-1.5 text-xs font-medium text-danger">
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
              Gravando…
            </span>
            <button
              onClick={toggleRecord}
              disabled={disabled || sending}
              className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-brand text-white transition hover:bg-brand-dark disabled:opacity-40"
              title="Parar e enviar"
            >
              {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
        ) : (
          <button
            onClick={toggleRecord}
            disabled={disabled || sending}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-brand text-white transition hover:bg-brand-dark disabled:opacity-40"
            title="Gravar áudio"
          >
            <Mic size={18} />
          </button>
        )}
      </div>
      )}
    </>
  );
}
