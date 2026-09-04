"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth";
import { getProvider } from "@/lib/whatsapp";
import { PREVIEW_MODE } from "@/lib/mock";
import { validarFeedback, formatFeedbackNovo, ehStatus, type StatusFeedback } from "@/lib/feedback";
import type { Channel } from "@/lib/types";

/** Print: só imagem, e um teto que cabe folgado num print de celular. */
const MAX_PRINT_BYTES = 8 * 1024 * 1024;

export type ResultadoFeedback = { ok: true } | { ok: false; erro: string };

/**
 * Aviso no grupo interno, só na CRIAÇÃO do card — mover não avisa (viraria o
 * ruído que a decisão de "sem notificação de status" evita).
 *
 * Nasce dormindo: settings.feedback_group_jid / feedback_notifier_channel_id
 * vazios = nada é postado. Nunca lança — o card já está salvo, este aviso é
 * conveniência (mesmo design do quadro do correa-atendimento; lá o transporte
 * é compartilhado com outras notificações internas que o MVF ainda não tem,
 * então aqui é só o necessário para este aviso).
 */
async function notifyFeedback(orgId: string, texto: string): Promise<void> {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
    const svc = createServiceClient();
    const { data: org } = await svc.from("organizations").select("settings").eq("id", orgId).maybeSingle();
    const s = ((org as { settings?: unknown } | null)?.settings ?? {}) as Record<string, unknown>;
    const groupJid = typeof s.feedback_group_jid === "string" ? s.feedback_group_jid.trim() : "";
    const channelId = typeof s.feedback_notifier_channel_id === "string" ? s.feedback_notifier_channel_id.trim() : "";
    if (!groupJid || !channelId) return;

    const { data: channel } = await svc.from("channels").select("*").eq("id", channelId).maybeSingle();
    if (!channel || (channel as Channel).type !== "uazapi" || (channel as Channel).status !== "connected") return;

    await getProvider(channel as Channel).sendText({ to: groupJid, text: texto });
  } catch {
    // Aviso é conveniência — nunca pode derrubar a criação do card.
  }
}

/**
 * Cria uma carta no quadro.
 *
 * NUNCA lança: erro vira `{ok:false,erro}` pro formulário mostrar sem perder o
 * que a pessoa digitou — um throw aqui viraria a página de erro do Next.
 */
export async function criarFeedback(fd: FormData): Promise<ResultadoFeedback> {
  if (PREVIEW_MODE) return { ok: true };
  const session = await getSession();
  if (!session?.organization) return { ok: false, erro: "Sessão expirada. Recarregue a página." };

  const v = validarFeedback({
    tipo: fd.get("tipo"),
    titulo: fd.get("titulo"),
    descricao: fd.get("descricao"),
  });
  if (!v.ok) return { ok: false, erro: v.erro };

  const supabase = await createClient();
  const { data: criado, error } = await supabase
    .from("feedback_items")
    .insert({
      organization_id: session.organization.id,
      tipo: v.tipo,
      titulo: v.titulo,
      descricao: v.descricao,
      criado_por: session.userId ?? null,
    })
    .select("id, numero")
    .single();

  if (error || !criado) {
    return { ok: false, erro: "Não deu pra salvar agora. Tente de novo em instantes." };
  }
  const { id, numero } = criado as { id: string; numero: number };

  // Print é OPCIONAL e é anexado depois do insert: se o upload falhar, o relato
  // já está salvo. Perder o texto por causa de uma imagem seria o pior desfecho.
  let temPrint = false;
  const file = fd.get("print") as File | null;
  if (file && file.size > 0 && file.size <= MAX_PRINT_BYTES && (file.type || "").startsWith("image/")) {
    try {
      const svc = createServiceClient();
      const ext = (file.name?.split(".").pop() || file.type.split("/")[1] || "png").slice(0, 5);
      const path = `${session.organization.id}/feedback/${id}.${ext}`;
      const up = await svc.storage.from("media").upload(path, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: true,
      });
      if (!up.error) {
        const url = svc.storage.from("media").getPublicUrl(path).data.publicUrl;
        await supabase.from("feedback_items").update({ print_url: url, print_path: path }).eq("id", id);
        temPrint = true;
      }
    } catch {
      // Segue sem print — o texto é o que importa.
    }
  }

  // Aviso no grupo, só na CRIAÇÃO. Fire-and-forget: falha no WhatsApp não pode
  // derrubar o card, que é o registro que não se perde.
  void notifyFeedback(
    session.organization.id,
    formatFeedbackNovo({
      numero,
      tipo: v.tipo,
      titulo: v.titulo,
      autor: session.profile?.name ?? null,
      temPrint,
      url: `${(process.env.APP_BASE_URL || "https://mvfchat.benitechlab.com").replace(/\/$/, "")}/melhorias`,
    }),
  ).catch(() => {});

  revalidatePath("/melhorias");
  return { ok: true };
}

/** Move a carta de coluna. Sem trava de permissão — todo mundo cria, move e vê. */
export async function moverFeedback(id: string, status: string): Promise<ResultadoFeedback> {
  if (PREVIEW_MODE) return { ok: true };
  if (!ehStatus(status)) return { ok: false, erro: "Status inválido." };
  const session = await getSession();
  if (!session?.organization) return { ok: false, erro: "Sessão expirada. Recarregue a página." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("feedback_items")
    .update({ status: status as StatusFeedback, status_em: new Date().toISOString() })
    .eq("id", id);

  if (error) return { ok: false, erro: "Não deu pra mover agora." };
  revalidatePath("/melhorias");
  return { ok: true };
}
