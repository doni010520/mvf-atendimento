"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Presença REAL dos atendentes (10/08/2026): quem está com o app aberto acende
 * a bolinha; fechou a aba/caiu a rede, apaga sozinho. Antes vinha de
 * profiles.status (campo MANUAL do cadastro) — todo mundo "offline" mesmo logado.
 *
 * Canal ÚNICO por aba (module singleton): o createBrowserClient é compartilhado
 * e assinar o MESMO tópico duas vezes na mesma conexão (layout + modal de
 * transferência) derruba uma assinatura à outra. Aqui todo mundo lê do mesmo
 * canal via usePresenceOnline(); só o PresenceTracker (layout) faz track.
 */
const TOPIC = "presence-online";
let ch: RealtimeChannel | null = null;
let lastIds = new Set<string>();
const listeners = new Set<(ids: Set<string>) => void>();

function ensureChannel(userId: string) {
  if (ch) return;
  const supabase = createClient();
  ch = supabase.channel(TOPIC, { config: { presence: { key: userId } } });
  ch.on("presence", { event: "sync" }, () => {
    lastIds = new Set(Object.keys(ch!.presenceState()));
    for (const l of listeners) l(new Set(lastIds));
  });
  ch.subscribe(async (status) => {
    // SUBSCRIBED dispara de novo a cada reconexão — re-track garante a presença.
    if (status === "SUBSCRIBED") await ch!.track({ at: new Date().toISOString() }).catch(() => {});
  });
}

/** Conjunto (reativo) de userIds com o app aberto agora. */
export function usePresenceOnline(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set(lastIds));
  useEffect(() => {
    const cb = (s: Set<string>) => setIds(s);
    listeners.add(cb);
    cb(new Set(lastIds));
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return ids;
}

/** Montado no layout: registra ESTE usuário como online enquanto a aba viver. */
export function PresenceTracker({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (userId) ensureChannel(userId);
  }, [userId]);
  return null;
}
