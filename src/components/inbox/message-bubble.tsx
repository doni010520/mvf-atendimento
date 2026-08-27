"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Message } from "@/lib/types";
import {
  Check, CheckCheck, Clock, AlertCircle, FileText, Download,
  Reply, SmilePlus, Pencil, Trash2, MoreVertical, X, Forward, MessageSquare, ExternalLink,
  QrCode, Copy,
} from "lucide-react";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** Formata hora de forma determinística (sem toLocaleTimeString que causa hydration mismatch). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Paleta de cores por participante (estilo WhatsApp) — determinística pelo nome.
const AUTHOR_COLORS = [
  "#d32f2f", "#1976d2", "#388e3c", "#7b1fa2", "#c2185b", "#0097a7",
  "#f57c00", "#5d4037", "#455a64", "#00796b", "#512da8", "#e64a19",
];
function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
}

/** Renderiza a formatação do WhatsApp: *negrito*, _itálico_, ~tachado~. */
function fmtWa(text: string): React.ReactNode[] {
  const RE = /([*_~])(\S(?:[^*_~\n]*\S)?|\S)\1/g;
  const out: React.ReactNode[] = [];
  let last = 0, k = 0;
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={k++}>{text.slice(last, m.index)}</span>);
    const inner = m[2];
    if (m[1] === "*") out.push(<strong key={k++}>{inner}</strong>);
    else if (m[1] === "_") out.push(<em key={k++}>{inner}</em>);
    else out.push(<span key={k++} className="line-through">{inner}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span key={k++}>{text.slice(last)}</span>);
  return out;
}

/** Detecta um código PIX copia-e-cola (EMV) dentro do corpo da mensagem.
 *  O EMV começa em "000201" e é uma sequência longa sem espaços. Devolve o
 *  código e o texto que veio antes/depois dele. */
function extractPix(body: string): { code: string; before: string; after: string } | null {
  const m = body.match(/000201[^\s]{30,}/);
  if (!m || m[0].length < 40) return null;
  const code = m[0];
  const idx = body.indexOf(code);
  return { code, before: body.slice(0, idx).trim(), after: body.slice(idx + code.length).trim() };
}

/** Cartão de PIX com botão "Copiar código" — dá ao atendente a mesma leitura
 *  boa que o cliente tem no WhatsApp, em vez de um código enorme "embolado". */
function PixCard({ code, out }: { code: string; out: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className={cn("mt-1 rounded-lg border p-2", out ? "border-white/25 bg-white/10" : "border-border bg-black/5")}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <QrCode size={13} /> PIX copia e cola
      </div>
      <p className={cn("mb-2 break-all font-mono text-[11px] leading-snug", out ? "text-white/80" : "text-ink-soft")}>
        {code.length > 64 ? `${code.slice(0, 64)}…` : code}
      </p>
      <button
        onClick={copy}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition",
          out ? "bg-white/20 text-white hover:bg-white/30" : "bg-brand text-white hover:bg-brand-dark",
        )}
      >
        {copied ? <><Check size={13} /> Copiado!</> : <><Copy size={13} /> Copiar código PIX</>}
      </button>
    </div>
  );
}

/** Transforma URLs no texto em links clicáveis (client-only para evitar hydration mismatch). */
function Linkify({ text, className }: { text: string; className?: string }) {
  const URL_RE = /(?:https?:\/\/|www\.)[^\s<]+|wa\.me\/[^\s<]+/g;

  const parts: (string | { url: string; display: string })[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0; // reset stateful regex
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    let url = match[0];
    // Remove trailing punctuation that's not part of the URL
    url = url.replace(/[.,;:!?)]+$/, "");
    const display = url;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    parts.push({ url, display });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  const hasLinks = parts.some((p) => typeof p !== "string");
  if (!hasLinks) {
    return <p className={className}>{fmtWa(text)}</p>;
  }

  return (
    <p className={className} suppressHydrationWarning>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{fmtWa(p)}</span>
        ) : (
          <a
            key={i}
            href={(p as { url: string }).url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline break-all hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            {(p as { display: string }).display}
          </a>
        ),
      )}
    </p>
  );
}

/**
 * Link de download com o nome ORIGINAL do arquivo.
 * O bucket "media" fica em outro dominio, entao o atributo `download` do <a> e
 * IGNORADO pelo navegador; sem Content-Disposition o arquivo caia no disco com
 * o nome do storage (e ".bin" quando o mimetype era octet-stream). O parametro
 * `?download=<nome>` do Supabase Storage manda o header certo.
 */
function downloadUrl(url: string, name?: string | null) {
  if (!/\/storage\/v1\/object\/public\//.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return name ? `${url}${sep}download=${encodeURIComponent(name)}` : `${url}${sep}download`;
}

function MediaContent({ message, onImageClick }: { message: Message; onImageClick?: (url: string) => void }) {
  const url = message.media_url;
  if (!url) return null;
  switch (message.content_type) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={url} alt="" onClick={() => onImageClick?.(url)} className="mb-1 max-h-72 cursor-zoom-in rounded-lg object-cover" />;
    case "sticker":
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={url} alt="" onClick={() => onImageClick?.(url)} className="mb-1 h-28 w-28 cursor-zoom-in object-contain" />;
    case "audio":
      return <audio controls src={url} className="mb-1 h-10 w-56 max-w-full" />;
    case "video":
      return <video controls src={url} className="mb-1 max-h-72 rounded-lg" />;
    case "document":
      return (
        <a
          href={downloadUrl(url, message.media_name)}
          target="_blank"
          rel="noreferrer"
          download={message.media_name || undefined}
          title={message.media_name || undefined}
          className="mb-1 flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-sm hover:bg-black/10"
        >
          <FileText size={18} />
          <span className="max-w-[220px] truncate underline">{message.media_name || "Abrir documento"}</span>
          <Download size={14} />
        </a>
      );
    default:
      return null;
  }
}

export function MessageBubble({
  message,
  isAdmin = false,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onAuthorClick,
  onReplyPrivate,
  quotedAuthor,
  quotedExcerpt,
}: {
  message: Message;
  isAdmin?: boolean;
  onReply?: (m: Message) => void;
  onReact?: (m: Message, emoji: string) => void;
  onEdit?: (m: Message) => void;
  onDelete?: (m: Message) => void;
  onAuthorClick?: (m: Message) => void;
  onReplyPrivate?: (m: Message) => void;
  quotedAuthor?: string | null;
  quotedExcerpt?: string | null;
}) {
  const out = message.direction === "out";
  const [menu, setMenu] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const time = message.created_at ? fmtTime(message.created_at) : "";
  const reactions = message.reactions ?? [];

  if (message.is_deleted) {
    // Apagada: o conteúdo original é mantido no banco para auditoria.
    // Mensagem da própria equipe (out) permanece visível a todos (auditoria interna);
    // o texto apagado PELO CLIENTE (in) só é revelado para administradores.
    const label =
      message.deleted_scope === "everyone" ? "Apagada para todos"
      : message.deleted_scope === "me" ? "Apagada (só aqui)"
      : "Mensagem apagada";
    const content = (out || isAdmin)
      ? (message.body ?? (message.content_type !== "text" ? `[${message.content_type}]` : null))
      : null;
    return (
      <div className={cn("flex", out ? "justify-end" : "justify-start")}>
        <div className="max-w-[70%] rounded-2xl border border-dashed border-border bg-gray-50 px-3 py-2 text-sm text-ink-soft opacity-60">
          <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-ink-soft/80">
            🚫 {label}
          </p>
          {content && <p className="whitespace-pre-wrap break-words italic line-through decoration-ink-soft/40">{content}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group flex items-end gap-1", out ? "justify-end" : "justify-start")}>
      {out && <Actions {...{ message, menu, setMenu, emoji, setEmoji, onReply, onReact, onEdit, onDelete, onReplyPrivate }} />}
      <div className="relative max-w-[70%]">
        <div
          onDoubleClick={() => onReply?.(message)}
          title="Duplo clique para responder"
          className={cn(
            "rounded-2xl px-3 py-2 text-sm shadow-sm",
            out ? "rounded-br-sm bg-brand text-white" : "rounded-bl-sm bg-surface text-ink",
            message.sender_type === "bot" && "bg-violet-100 text-violet-900",
            message.sender_type === "system" && "bg-gray-200 text-gray-600 italic",
          )}
        >
          {!out && message.author_name &&
            ((message.author_phone || message.author_lid) && onAuthorClick ? (
              <button
                onClick={() => onAuthorClick(message)}
                className="mb-0.5 text-xs font-semibold hover:underline"
                style={{ color: colorForName(message.author_name) }}
                title="Abrir conversa com este contato"
              >
                {message.author_name}
              </button>
            ) : (
              <p className="mb-0.5 text-xs font-semibold" style={{ color: colorForName(message.author_name) }}>
                {message.author_name}
              </p>
            ))}
          {(quotedExcerpt ?? message.reply_excerpt) && (
            <div className={cn("mb-1 rounded border-l-2 px-2 py-1 text-xs", out ? "border-white/60 bg-white/15" : "border-brand/50 bg-black/5 text-ink-soft")}>
              {(() => {
                const a = quotedAuthor ?? message.reply_author;
                return a && !/^\d+$/.test(a) ? <span className="font-medium">{a}: </span> : null;
              })()}
              {(quotedExcerpt ?? message.reply_excerpt ?? "").slice(0, 120)}
            </div>
          )}
          {message.media_url ? (
            <MediaContent message={message} onImageClick={setLightbox} />
          ) : (
            message.content_type !== "text" && <p className="mb-1 text-xs opacity-80">[{message.content_type}]</p>
          )}
          {message.body && (() => {
            const pix = !message.media_url && message.content_type === "text" ? extractPix(message.body) : null;
            if (pix) {
              return (
                <>
                  {pix.before && <Linkify text={pix.before} className="whitespace-pre-wrap break-words" />}
                  <PixCard code={pix.code} out={out} />
                  {pix.after && <Linkify text={pix.after} className="mt-1 whitespace-pre-wrap break-words" />}
                </>
              );
            }
            return <Linkify text={message.body} className="whitespace-pre-wrap break-words" />;
          })()}
          <div className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", out ? "text-white/70" : "text-ink-soft")} suppressHydrationWarning>
            {message.edited && <span className="italic">editada</span>}
            {time}
            {out && message.status === "failed" ? (
              <span
                className="flex items-center gap-0.5 rounded bg-red-600 px-1 py-px font-semibold text-white"
                title="A Meta recusou a entrega — geralmente cliente sem conversa nas últimas 24h (janela fechada). Se for texto, o sistema reenvia sozinho como mensagem automática."
              >
                <AlertCircle size={10} /> não entregue
              </span>
            ) : (
              out && <StatusIcon status={message.status} />
            )}
          </div>
        </div>
        {reactions.length > 0 && (
          <div className={cn("absolute -bottom-2 flex gap-0.5 rounded-full border border-border bg-surface px-1 text-xs shadow-sm", out ? "right-2" : "left-2")}>
            {reactions.map((r, i) => (
              <span key={i} title={r.by}>{r.emoji}</span>
            ))}
          </div>
        )}
      </div>
      {!out && <Actions {...{ message, menu, setMenu, emoji, setEmoji, onReply, onReact, onEdit, onDelete, onReplyPrivate }} />}

      {lightbox && (
        // Overlay ROLÁVEL: comprovantes/prints são altos e estreitos. Em vez de
        // espremer a imagem inteira na altura da tela (virava uma fita ilegível),
        // mostramos numa largura confortável e deixamos rolar pra baixo.
        <div className="fixed inset-0 z-[70] overflow-auto bg-black/80" onClick={() => setLightbox(null)}>
          <button onClick={() => setLightbox(null)} className="fixed right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" title="Fechar">
            <X size={22} />
          </button>
          <div className="fixed bottom-4 right-4 z-10 flex items-center gap-2">
            <a
              href={lightbox}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
              title="Abrir o arquivo original em outra aba"
            >
              <ExternalLink size={16} /> Abrir original
            </a>
            <a
              href={downloadUrl(lightbox, message.media_name)}
              download={message.media_name || undefined}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/20"
              title="Baixar"
            >
              <Download size={16} /> Baixar
            </a>
          </div>
          <div className="flex min-h-full items-center justify-center p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox}
              alt=""
              onClick={(e) => e.stopPropagation()}
              className="h-auto w-auto max-w-[min(92vw,820px)] rounded-lg shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Actions({
  message, menu, setMenu, emoji, setEmoji, onReply, onReact, onEdit, onDelete, onReplyPrivate,
}: {
  message: Message; menu: boolean; setMenu: (v: boolean) => void; emoji: boolean; setEmoji: (v: boolean) => void;
  onReply?: (m: Message) => void; onReact?: (m: Message, e: string) => void; onEdit?: (m: Message) => void; onDelete?: (m: Message) => void;
  onReplyPrivate?: (m: Message) => void;
}) {
  const out = message.direction === "out";
  return (
    <div className="relative flex shrink-0 items-center self-center opacity-0 transition group-hover:opacity-100">
      <button onClick={() => { setEmoji(!emoji); setMenu(false); }} className="rounded-full p-1 text-ink-soft hover:bg-gray-100" title="Reagir">
        <SmilePlus size={15} />
      </button>
      <button onClick={() => onReply?.(message)} className="rounded-full p-1 text-ink-soft hover:bg-gray-100" title="Responder">
        <Reply size={15} />
      </button>
      <button onClick={() => { setMenu(!menu); setEmoji(false); }} className="rounded-full p-1 text-ink-soft hover:bg-gray-100" title="Mais">
        <MoreVertical size={15} />
      </button>

      {emoji && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setEmoji(false)} />
          <div className="absolute bottom-7 z-20 flex gap-1 rounded-full border border-border bg-surface px-2 py-1 shadow-lg">
            {QUICK_EMOJIS.map((e) => (
              <button key={e} onClick={() => { onReact?.(message, e); setEmoji(false); }} className="text-lg hover:scale-125 transition">{e}</button>
            ))}
          </div>
        </>
      )}
      {menu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div className="absolute bottom-7 z-20 w-36 overflow-hidden rounded-lg border border-border bg-surface py-1 text-sm shadow-xl">
            <button onClick={() => { onReply?.(message); setMenu(false); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-ink hover:bg-gray-50">
              <Reply size={14} /> Responder
            </button>
            {!out && onReplyPrivate && (message.author_phone || message.author_lid) && (
              <button onClick={() => { onReplyPrivate(message); setMenu(false); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-ink hover:bg-gray-50">
                <MessageSquare size={14} /> Responder no privado
              </button>
            )}
            {out && onEdit && (
              <button onClick={() => { onEdit(message); setMenu(false); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-ink hover:bg-gray-50">
                <Pencil size={14} /> Editar
              </button>
            )}
            <button onClick={() => {
              setMenu(false);
              const text = message.body ?? `[${message.content_type}]`;
              navigator.clipboard.writeText(text);
              alert("Mensagem copiada para a área de transferência. Cole em outra conversa para encaminhar.");
            }} className="flex w-full items-center gap-2 px-3 py-1.5 text-ink hover:bg-gray-50">
              <Forward size={14} /> Encaminhar
            </button>
            {onDelete && (
              <button onClick={() => { onDelete(message); setMenu(false); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-danger hover:bg-red-50">
                <Trash2 size={14} /> Apagar
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "pending":
      return <Clock size={12} />;
    case "sent":
      return <Check size={12} />;
    case "delivered":
      return <CheckCheck size={12} />;
    case "read":
      return <CheckCheck size={12} className="text-sky-200" />;
    case "failed":
      return <AlertCircle size={12} className="text-red-200" />;
    default:
      return null;
  }
}
