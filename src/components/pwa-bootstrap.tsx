"use client";

import { useEffect } from "react";
import { registerServiceWorker, syncPushSubscription } from "@/lib/push-client";

const KILL_KEY = "mvf_nosw";

/**
 * Liga o lado PWA do app: registra o service worker e mantém a inscrição de
 * push deste aparelho em dia. Não desenha nada na tela.
 *
 * ESCAPE HATCH: abrir o app com `?nosw=1` (ex.:
 * https://mvfchat.benitechlab.com/atendimento?nosw=1) apaga o service worker e
 * os caches DAQUELE aparelho e memoriza a escolha. `?nosw=0` volta ao normal.
 * Existe porque service worker ruim fica preso no celular do atendente e não
 * sai com F5 — sem isso, o conserto dependeria de deploy.
 *
 * Em desenvolvimento o SW nem é registrado (atrapalharia o hot reload).
 */
export function PwaBootstrap() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

      // 1) Interruptor por aparelho.
      try {
        const flag = new URLSearchParams(window.location.search).get("nosw");
        if (flag === "1") localStorage.setItem(KILL_KEY, "1");
        if (flag === "0") localStorage.removeItem(KILL_KEY);
        if (localStorage.getItem(KILL_KEY) === "1") {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
          if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(keys.filter((k) => k.startsWith("mvf-")).map((k) => caches.delete(k)));
          }
          return;
        }
      } catch {
        /* localStorage bloqueado: segue o fluxo normal */
      }

      if (process.env.NODE_ENV !== "production") return;

      // 2) Registro + reconciliação da inscrição de push (silenciosa).
      const reg = await registerServiceWorker();
      if (!reg || cancelled) return;
      await syncPushSubscription();
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
