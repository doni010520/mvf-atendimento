"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

/** Canal único de presença do app — quem está com o sistema aberto aparece aqui. */
export const PRESENCE_CHANNEL = "presence-online";

/**
 * Marca este usuário como ONLINE via Supabase Realtime Presence enquanto a aba
 * estiver aberta (10/08/2026). Antes a bolinha "online" dos atendentes vinha de
 * profiles.status, um campo MANUAL do cadastro — todo mundo aparecia offline
 * mesmo logado. Presence é efêmero: fechou a aba/caiu a rede, some sozinho.
 */
export function PresenceTracker({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    const ch = supabase.channel(PRESENCE_CHANNEL, { config: { presence: { key: userId } } });
    ch.subscribe(async (status) => {
      if (status === "SUBSCRIBED") await ch.track({ at: new Date().toISOString() });
    });
    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId]);
  return null;
}
