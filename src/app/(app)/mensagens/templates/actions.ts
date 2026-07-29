"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth";
import { listMetaTemplates } from "@/lib/whatsapp/meta";
import { orgInsert, orgUpdate, orgDelete } from "@/lib/crud-helpers";

/**
 * Sincroniza os modelos aprovados direto da Meta para a tabela wa_templates.
 * Varre TODOS os canais Meta conectados (cada WABA tem seu próprio conjunto de
 * templates aprovados) — antes só olhava o 1º canal encontrado, então quando a
 * org passou a ter mais de um WABA (ex.: números migrados de outra plataforma),
 * o sync perdia os templates dos demais. Se nenhum canal existir, cai no
 * fallback via env (META_WABA_ID/META_ACCESS_TOKEN).
 */
export async function syncMetaTemplates(): Promise<{ ok: boolean; count?: number; error?: string }> {
  const session = await getSession();
  if (!session?.organization) return { ok: false, error: "Sessão inválida." };
  const sb = await createClient();

  const { data: channels } = await sb
    .from("channels")
    .select("id, name, credentials")
    .eq("type", "meta_cloud");

  const sources = ((channels ?? []) as { id: string; name: string; credentials: Record<string, unknown> }[])
    .map((c) => ({
      channelId: c.id as string | null,
      wabaId: (c.credentials?.waba_id as string) || undefined,
      token: (c.credentials?.access_token as string) || undefined,
      label: c.name,
    }))
    .filter((s) => s.wabaId && s.token);

  // Sem nenhum canal Meta cadastrado: fallback pro par WABA/token global do .env.
  if (!sources.length && process.env.META_WABA_ID && process.env.META_ACCESS_TOKEN) {
    sources.push({ channelId: null, wabaId: process.env.META_WABA_ID, token: process.env.META_ACCESS_TOKEN, label: "env" });
  }
  if (!sources.length) return { ok: false, error: "Nenhum canal Meta com waba_id/token configurado." };

  // Ignora os modelos de AMOSTRA/biblioteca da Meta (não servem para envio real).
  const SAMPLE = /^(hello_world$|jaspers_market_|sample_)/i;

  const { data: existing } = await sb.from("wa_templates").select("id, channel_id, name, language");
  const byKey = new Map((existing ?? []).map((t) => [`${t.channel_id}|${t.name}|${t.language}`, t.id]));

  let count = 0;
  const errors: string[] = [];
  for (const src of sources) {
    let list: Awaited<ReturnType<typeof listMetaTemplates>>;
    try {
      list = await listMetaTemplates(src.wabaId!, src.token!);
    } catch (e) {
      errors.push(`${src.label}: ${(e as Error)?.message?.slice(0, 120)}`);
      continue;
    }
    for (const t of list.filter((t) => !SAMPLE.test(t.name))) {
      const row = {
        organization_id: session.organization.id,
        channel_id: src.channelId,
        name: t.name,
        language: t.language,
        category: t.category ?? "UTILITY",
        status: t.status,
        components: t.components ?? [],
      };
      const id = byKey.get(`${src.channelId}|${t.name}|${t.language}`);
      if (id) await sb.from("wa_templates").update(row).eq("id", id);
      else await sb.from("wa_templates").insert(row);
      count++;
    }
  }

  revalidatePath("/mensagens/templates");
  if (!count && errors.length) return { ok: false, error: errors.join(" | ").slice(0, 300) };
  return { ok: true, count };
}

export async function createTemplate(fd: FormData) {
  await orgInsert("wa_templates", {
    name: String(fd.get("name") || "").trim(),
    language: String(fd.get("language") || "pt_BR"),
    category: String(fd.get("category") || "UTILITY"),
    status: "pending",
    components: JSON.parse(String(fd.get("components") || "[]")),
  });
  revalidatePath("/mensagens/templates");
}

export async function updateTemplate(id: string, fd: FormData) {
  await orgUpdate("wa_templates", id, {
    name: String(fd.get("name") || "").trim(),
    language: String(fd.get("language") || "pt_BR"),
    category: String(fd.get("category") || "UTILITY"),
    components: JSON.parse(String(fd.get("components") || "[]")),
  });
  revalidatePath("/mensagens/templates");
}

export async function deleteTemplate(id: string) {
  await orgDelete("wa_templates", id);
  revalidatePath("/mensagens/templates");
}
