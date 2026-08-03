"use client";

import { useEffect, useRef, useState } from "react";
import { APP_VERSION } from "@/lib/version";

/**
 * Detecta que saiu uma versão nova do app e oferece recarregar. Resolve o
 * problema recorrente de "precisa dar F5": quem fica com a aba aberta continua
 * no bundle antigo depois de um deploy (realtime/polling do código velho).
 * Compara o APP_VERSION embutido no bundle com o /api/version do servidor.
 */
/** Marca/desmarca "ocupado" (gravando áudio, atendimento aberto): enquanto
 *  ocupado o VersionWatcher NUNCA recarrega a página sozinho. */
export function setAppBusy(busy: boolean) {
  if (typeof document === "undefined") return;
  if (busy) document.body.dataset.appBusy = "1";
  else delete document.body.dataset.appBusy;
}

export function VersionWatcher() {
  const [stale, setStale] = useState(false);
  const staleRef = useRef(false);
  const loaded = useRef(APP_VERSION);
  // Versão diferente vista na checagem anterior: só agimos quando a MESMA
  // versão nova aparece 2x seguidas. Sem isso, se dois containers de versões
  // diferentes estiverem no ar (rolling deploy preso), a resposta alterna e o
  // watcher recarregava a página a cada minuto, sem parar.
  const pending = useRef<string | null>(null);
  useEffect(() => { staleRef.current = stale; }, [stale]);

  useEffect(() => {
    let cancel = false;
    const busy = () => document.body.dataset.appBusy === "1";
    const markStale = () => {
      // Nunca recarrega no meio de algo (gravando áudio / atendimento aberto).
      if (busy()) { setStale(true); return; }
      // Aba em segundo plano → recarrega sozinha (não há nada a perder).
      if (document.hidden) { window.location.reload(); return; }
      // Aba ATIVA: nunca força. Mostra o aviso e deixa o atendente escolher a
      // hora — recarregar por baixo do atendimento em uso é pior que o bundle
      // velho (fechava modal, cortava gravação, perdia o que estava na tela).
      setStale(true);
    };
    const check = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const j = (await r.json()) as { version?: string };
        if (cancel || !j.version) return;
        if (j.version === loaded.current) { pending.current = null; return; }
        if (pending.current === j.version) markStale(); // confirmada 2x seguidas
        else pending.current = j.version;
      } catch {
        /* silencioso */
      }
    };
    const onVis = () => {
      // Saiu da aba estando desatualizado → aproveita para atualizar (a menos
      // que esteja gravando/atendendo).
      if (document.hidden) { if (staleRef.current && !busy()) window.location.reload(); }
      else check(); // voltou pra aba → confere na hora
    };
    const t = setInterval(check, 60000); // a cada 1 min
    document.addEventListener("visibilitychange", onVis);
    check();
    return () => { cancel = true; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  if (!stale) return null;
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 animate-pulse rounded-full bg-brand px-4 py-2 text-sm font-medium text-white shadow-lg transition hover:animate-none hover:bg-brand-dark"
    >
      🔄 Nova versão disponível — clique para atualizar
    </button>
  );
}
