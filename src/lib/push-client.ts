"use client";

/**
 * Helpers de PWA/push no NAVEGADOR (o lado servidor fica em src/lib/push/).
 *
 * Nada aqui pode lançar para fora: navegador sem suporte, permissão negada ou
 * rede caída devolvem um resultado, nunca uma exceção que quebre a tela.
 */

export type PushState = "unsupported" | "denied" | "off" | "on";

/** Converte a chave VAPID (base64url) para o formato que o navegador exige. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** true quando o app está aberto como app instalado (não como aba do navegador). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await getRegistration();
  if (!reg) return "off";
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  return sub ? "on" : "off";
}

async function saveOnServer(sub: PushSubscription): Promise<boolean> {
  try {
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Liga as notificações neste aparelho: pede permissão, assina no serviço de
 * push e registra no servidor. Deve ser chamada a partir de um clique — iOS e
 * Safari exigem gesto do usuário para o pedido de permissão.
 */
export async function enablePush(): Promise<{ ok: boolean; state: PushState; error?: string }> {
  if (!pushSupported()) return { ok: false, state: "unsupported" };

  if (isIOS() && !isStandalone()) {
    return {
      ok: false,
      state: "off",
      error: "No iPhone, primeiro adicione o app à Tela de Início (Compartilhar → Adicionar à Tela de Início) e abra por lá.",
    };
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return {
        ok: false,
        state: permission === "denied" ? "denied" : "off",
        error:
          permission === "denied"
            ? "As notificações foram bloqueadas para este site. Libere nas permissões do navegador e tente de novo."
            : undefined,
      };
    }

    await registerServiceWorker();
    const reg = await getRegistration();
    if (!reg) return { ok: false, state: "off", error: "Não foi possível iniciar o serviço de notificações." };

    const res = await fetch("/api/push/vapid");
    if (!res.ok) return { ok: false, state: "off", error: "Servidor de notificações indisponível." };
    const { publicKey } = (await res.json()) as { publicKey?: string };
    if (!publicKey) return { ok: false, state: "off", error: "Servidor de notificações indisponível." };

    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));

    const saved = await saveOnServer(sub);
    if (!saved) return { ok: false, state: "off", error: "Não foi possível registrar o aparelho." };
    return { ok: true, state: "on" };
  } catch (err) {
    return { ok: false, state: "off", error: (err as Error)?.message ?? "Falha ao ativar." };
  }
}

/** Desliga as notificações neste aparelho. */
export async function disablePush(): Promise<PushState> {
  try {
    const reg = await getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch {
    /* ignora */
  }
  return "off";
}

/**
 * Reconciliação silenciosa: quem já autorizou continua registrado no servidor
 * mesmo depois de o navegador trocar a inscrição (acontece sozinho de tempos
 * em tempos) ou de o registro ter se perdido. Não pede permissão a ninguém.
 */
export async function syncPushSubscription(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== "granted") return;
    const reg = await getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await saveOnServer(sub);
      return;
    }
    const res = await fetch("/api/push/vapid");
    if (!res.ok) return;
    const { publicKey } = (await res.json()) as { publicKey?: string };
    if (!publicKey) return;
    const fresh = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    await saveOnServer(fresh);
  } catch {
    /* silencioso de propósito */
  }
}
