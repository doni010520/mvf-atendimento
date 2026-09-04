import type { Channel } from "@/lib/types";
import type {
  ChannelProvider,
  ConnectResult,
  SendMediaParams,
  SendTextParams,
  PixCardParams,
  InboundMessage,
} from "./types";
import { transcribeAudio } from "./transcribe";
import { toMp3 } from "./audio-transcode";
import { logEvent } from "@/lib/log";

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v23.0"}`;

const MIME_BY_EXT: Record<string, string> = {
  ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", amr: "audio/amr",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", "3gp": "video/3gpp",
  pdf: "application/pdf",
};

interface MetaCreds {
  phone_number_id?: string;
  access_token?: string;
  waba_id?: string;
}

export class MetaProvider implements ChannelProvider {
  private phoneNumberId?: string;
  private accessToken?: string;
  private orgId?: string | null;

  constructor(channel: Channel) {
    const c = channel.credentials as MetaCreds;
    this.phoneNumberId = c?.phone_number_id ?? channel.external_id ?? undefined;
    this.accessToken = c?.access_token || process.env.META_ACCESS_TOKEN;
    this.orgId = channel.organization_id;
  }

  /**
   * `131000 "Something went wrong"` é erro TRANSITÓRIO do lado da Meta (HTTP
   * 500 genérico, não é problema com a mensagem/número) — confirmado: um
   * reenvio manual segundos depois, com o texto idêntico, sempre entregou
   * (caso Alexandre Morsan → Geovana Nascimento, 04/09). Sem retry, o
   * atendente via "não entregue" para algo que um segundo envio já resolvia
   * sozinho.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async graph(path: string, body: unknown, _retried = false): Promise<any> {
    const res = await fetch(`${GRAPH}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (!_retried && /"code"\s*:\s*131000/.test(text)) {
        await new Promise((r) => setTimeout(r, 1200));
        return this.graph(path, body, true);
      }
      throw new Error(`Meta ${path} -> ${res.status} ${text}`);
    }
    return res.json();
  }

  /**
   * Baixa uma mídia recebida na Meta: (1) pega a URL temporária via Graph API
   * pelo media id; (2) baixa os bytes COM o token (a URL exige Authorization);
   * (3) áudio é transcrito via OpenAI (Whisper). Devolve os bytes — o re-host no
   * Storage é feito pelo storeInboundMedia.
   */
  async downloadMedia(mediaId: string): Promise<{ buffer?: Buffer; mimetype?: string; transcription?: string }> {
    if (!mediaId || !this.accessToken) return {};
    try {
      const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!metaRes.ok) return {};
      const info = (await metaRes.json()) as { url?: string; mime_type?: string };
      if (!info.url) return {};
      const fileRes = await fetch(info.url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!fileRes.ok) return { mimetype: info.mime_type };
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const mimetype = info.mime_type || fileRes.headers.get("content-type") || undefined;
      let transcription: string | undefined;
      if (mimetype?.startsWith("audio") && process.env.OPENAI_API_KEY) {
        transcription = await transcribeAudio(buffer, mimetype).catch(() => undefined);
      }
      return { buffer, mimetype, transcription };
    } catch {
      return {};
    }
  }

  // Meta não usa QR/código: a "conexão" é a validação das credenciais.
  async connect(_phone?: string): Promise<ConnectResult> {
    if (!this.phoneNumberId || !this.accessToken) {
      return { status: "error" };
    }
    return { status: "connected", externalId: this.phoneNumberId };
  }

  async status(): Promise<Channel["status"]> {
    return this.phoneNumberId && this.accessToken ? "connected" : "disconnected";
  }

  async sendText({ to, text }: SendTextParams) {
    const r = await this.graph(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    });
    return { externalId: r?.messages?.[0]?.id };
  }

  /**
   * Sobe a mídia para a Meta (/media) e devolve o media id. Enviar por ID é
   * MUITO mais confiável que por link: com link a Meta não persistia o arquivo
   * e o cliente via "Este áudio/mídia não está mais disponível" ao abrir.
   */
  private async uploadMedia(url: string, kind: string): Promise<{ id: string; bytes: number; mime: string }> {
    const fileRes = await fetch(url);
    if (!fileRes.ok) throw new Error(`fetch media ${fileRes.status}`);
    let buf: Buffer = Buffer.from(await fileRes.arrayBuffer());
    let ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
    let mime =
      fileRes.headers.get("content-type")?.split(";")[0] ||
      MIME_BY_EXT[ext] ||
      (kind === "audio" ? "audio/ogg" : kind === "image" ? "image/jpeg" : "application/octet-stream");
    // Áudio ogg/opus/webm → MP3 antes de subir. O WhatsApp no iPhone recusava
    // nossos ogg/opus ("áudio não está mais disponível") mesmo íntegros e
    // delivered; o mesmo áudio em MP3 toca. Cobre TODOS os remetentes (bot com
    // TTS incluso), pois este é o ponto único de saída de mídia para a Meta.
    if (kind === "audio" && /ogg|opus|webm/i.test(`${mime} ${ext}`)) {
      const mp3 = await toMp3(buf);
      if (mp3 && mp3.length > 1000) { buf = mp3; ext = "mp3"; mime = "audio/mpeg"; }
    }
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("type", mime);
    fd.append("file", new Blob([new Uint8Array(buf)], { type: mime }), `file.${ext || "bin"}`);
    const up = await fetch(`${GRAPH}/${this.phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: fd,
    });
    const j = (await up.json().catch(() => ({}))) as { id?: string };
    if (!up.ok || !j.id) throw new Error(`upload /media ${up.status} ${JSON.stringify(j).slice(0, 150)}`);
    return { id: j.id, bytes: buf.length, mime };
  }

  async sendMedia({ to, url, caption, kind, filename }: SendMediaParams) {
    // Só imagem/vídeo/documento aceitam `caption` na Cloud API. Áudio e sticker
    // NÃO — mandar caption (mesmo string vazia) faz a Meta rejeitar o envio.
    const supportsCaption = kind === "image" || kind === "video" || kind === "document";
    // Envia por ID (sobe pra /media) em vez de por link — link deixava a mídia
    // "não disponível" no cliente. Fallback pro link se o upload falhar.
    const media: Record<string, unknown> = {};
    try {
      const r = await this.uploadMedia(url, kind);
      media.id = r.id;
      void logEvent("info", "meta", `mídia ${kind} enviada por ID (${r.bytes}B, ${r.mime})`, { kind, method: "id", bytes: r.bytes, mediaId: r.id, mime: r.mime, url }, this.orgId);
    } catch (e) {
      media.link = url;
      void logEvent("error", "meta", `uploadMedia FALHOU (${kind}) -> fallback LINK: ${(e as Error)?.message}`, { kind, method: "link", url, error: (e as Error)?.message }, this.orgId);
    }
    if (supportsCaption && caption) media.caption = caption;
    // Documento SEM filename aparece no WhatsApp com o nome gerado do storage.
    if (kind === "document" && filename) media.filename = filename;
    const r = await this.graph(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: kind,
      [kind]: media,
    });
    return { externalId: r?.messages?.[0]?.id };
  }

  /**
   * Envia uma mensagem de MODELO (template) — único tipo permitido fora da
   * janela de 24h em canais Meta oficiais. `components` no formato da Graph API.
   */
  async sendTemplate({ to, name, language, components }: {
    to: string;
    name: string;
    language: string;
    components?: unknown[];
  }) {
    const r = await this.graph(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name,
        language: { code: language || "pt_BR" },
        ...(components && components.length ? { components } : {}),
      },
    });
    return { externalId: r?.messages?.[0]?.id };
  }

  /**
   * PIX com card nativo (Offsite Pix / order_details) — o cliente recebe um
   * card "Código Pix / R$ X / Copiar código pix". Precisa do valor; sem ele,
   * retorna { unsupported } e o chamador manda como texto.
   * Testado: aceita o PIX copia-e-cola completo. Não exige onboarding extra.
   */
  async sendPixCard(p: PixCardParams): Promise<{ externalId?: string; unsupported?: boolean }> {
    if (!p.amountCents) return { unsupported: true };
    const amount = { value: p.amountCents, offset: 100 };
    const r = await this.graph(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: p.to,
      type: "interactive",
      interactive: {
        type: "order_details",
        body: { text: p.text },
        action: {
          name: "review_and_pay",
          parameters: {
            reference_id: p.refId ?? `pix-${Date.now()}`,
            type: "digital-goods",
            payment_type: "br",
            currency: "BRL",
            total_amount: amount,
            order: {
              status: "pending",
              items: [{ retailer_id: p.refId ?? "1", name: p.itemName ?? "Fatura", amount, quantity: 1 }],
              subtotal: amount,
            },
            payment_settings: [{
              type: "pix_dynamic_code",
              pix_dynamic_code: {
                code: p.code,
                merchant_name: p.merchantName ?? "MVF NET",
                key: p.pixKey ?? "07861662000103",
                key_type: p.pixKeyType ?? "CNPJ",
              },
            }],
          },
        },
      },
    });
    return { externalId: r?.messages?.[0]?.id };
  }
}

/** Lista os modelos (templates) de uma WABA na Meta. */
export async function listMetaTemplates(wabaId: string, token: string) {
  const res = await fetch(
    `${GRAPH}/${wabaId}/message_templates?fields=name,status,language,category,components&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`listMetaTemplates: ${JSON.stringify(json)}`);
  return (json?.data ?? []) as Array<{
    name: string;
    status: string;
    language: string;
    category?: string;
    components?: unknown[];
  }>;
}

// ===================== Coexistência / Onboarding (Embedded Signup) =====================

const APP_ID = () => process.env.META_APP_ID || "";
const APP_SECRET = () => process.env.META_APP_SECRET || "";

/** Troca o `code` do Embedded Signup por um token de System User do cliente. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const url =
    `${GRAPH}/oauth/access_token?client_id=${APP_ID()}` +
    `&client_secret=${APP_SECRET()}&code=${encodeURIComponent(code)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || !json?.access_token) {
    throw new Error(`exchangeCodeForToken: ${JSON.stringify(json)}`);
  }
  return json.access_token as string;
}

/** Inscreve nosso app na WABA do cliente (ativa os webhooks da conta). */
export async function subscribeApp(wabaId: string, token: string) {
  const res = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`subscribeApp: ${JSON.stringify(json)}`);
  return json;
}

/**
 * Define o webhook no nível do número (override) — necessário para receber
 * `smb_message_echoes` (mensagens enviadas pelo app WhatsApp Business).
 * Confirme o shape exato na doc da Meta no momento da implantação.
 */
export async function setPhoneWebhook(phoneNumberId: string, token: string) {
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const res = await fetch(`${GRAPH}/${phoneNumberId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      webhook_configuration: {
        override_callback_uri: `${base}/api/webhooks/meta`,
        verify_token: process.env.META_VERIFY_TOKEN || "",
      },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`setPhoneWebhook: ${JSON.stringify(json)}`);
  return json;
}

/** Busca os números (e seus IDs) de uma WABA. */
export async function getPhoneNumbers(wabaId: string, token: string) {
  const res = await fetch(`${GRAPH}/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`getPhoneNumbers: ${JSON.stringify(json)}`);
  return (json?.data ?? []) as Array<{ id: string; display_phone_number: string; verified_name?: string }>;
}

/** Eco de mensagem enviada pelo atendente no app WhatsApp Business (saída). */
export interface OutboundEcho {
  channelExternalId: string;
  to: string;
  contentType: InboundMessage["contentType"];
  body?: string;
  externalId?: string;
  timestamp?: string;
}

/** Mudança no catálogo de contatos do app Business. */
export interface ContactStateSync {
  channelExternalId: string;
  phone: string;
  name?: string;
  action: "add" | "update" | "remove" | string;
}

/** Status de entrega reportado pela Meta (sent/delivered/read/failed). */
export interface MetaStatus {
  externalId: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipient?: string;
  errorCode?: number;
  errorTitle?: string;
  errorDetails?: string;
}

/**
 * statuses[] do webhook: é aqui que a Meta diz se a mensagem foi ENTREGUE e,
 * quando falha, POR QUÊ (código + descrição). Sem processar isso, mensagens
 * ficavam eternamente em "sent" e a causa real de falhas de mídia se perdia.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseMetaStatuses(payload: any): MetaStatus[] {
  const out: MetaStatus[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const s of change?.value?.statuses ?? []) {
        const err = s?.errors?.[0];
        out.push({
          externalId: String(s?.id ?? ""),
          status: s?.status,
          recipient: s?.recipient_id,
          errorCode: err?.code,
          errorTitle: err?.title,
          errorDetails: err?.error_data?.details ?? err?.message,
        });
      }
    }
  }
  return out.filter((s) => s.externalId && s.status);
}

/** smb_message_echoes → mensagens de saída enviadas pelo celular. */
export function parseMetaEchoes(payload: any): OutboundEcho[] {
  const out: OutboundEcho[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "smb_message_echoes") continue;
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      for (const m of value?.message_echoes ?? []) {
        out.push({
          channelExternalId: phoneNumberId,
          to: String(m?.to ?? "").replace(/\D/g, ""),
          contentType: (m?.type ?? "text") as InboundMessage["contentType"],
          body: m?.text?.body ?? m?.[m?.type]?.caption,
          externalId: m?.id,
          timestamp: m?.timestamp,
        });
      }
    }
  }
  return out;
}

/** smb_app_state_sync → contatos adicionados/alterados/removidos. */
export function parseMetaStateSync(payload: any): ContactStateSync[] {
  const out: ContactStateSync[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "smb_app_state_sync") continue;
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      for (const s of value?.state_sync ?? []) {
        if (s?.type !== "contact") continue;
        out.push({
          channelExternalId: phoneNumberId,
          phone: String(s?.contact?.phone_number ?? "").replace(/\D/g, ""),
          name: s?.contact?.full_name ?? s?.contact?.first_name,
          action: s?.action ?? "add",
        });
      }
    }
  }
  return out;
}

/** Normaliza o webhook da Meta Cloud API em mensagens internas. */
export function parseMetaWebhook(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      const contactName = value?.contacts?.[0]?.profile?.name;
      for (const m of value?.messages ?? []) {
        out.push({
          channelExternalId: phoneNumberId,
          from: String(m?.from ?? "").replace(/\D/g, ""),
          contactName,
          contentType: (m?.type ?? "text") as InboundMessage["contentType"],
          body: m?.text?.body ?? m?.[m?.type]?.caption,
          mediaUrl: undefined, // a mídia da Meta é baixada depois via Graph API (downloadMedia)
          mediaId: m?.[m?.type]?.id, // id da mídia (audio/image/video/document/sticker)
          fileName: m?.document?.filename ?? undefined,
          externalId: m?.id,
          timestamp: m?.timestamp,
        });
      }
    }
  }
  return out;
}
