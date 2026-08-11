"use server";

import { revalidatePath } from "next/cache";
import { orgInsert, orgDelete } from "@/lib/crud-helpers";
import { getSession, isAdmin } from "@/lib/auth";
import { IntegrationSchema, fdToObj, parse, zUuid } from "@/lib/validation";
import { encryptSgpConfig } from "@/lib/crypto";

export async function createIntegration(fd: FormData) {
  const raw = parse(IntegrationSchema, fdToObj(fd));
  const config = encryptSgpConfig(raw as Record<string, string>);
  await orgInsert("integrations", {
    type: "sgp",
    config,
  });
  revalidatePath("/integracoes");
}

export async function deleteIntegration(id: string) {
  parse(zUuid, id);
  await orgDelete("integrations", id);
  revalidatePath("/integracoes");
}

/**
 * Define COMO os clientes desta unidade SGP pagam por PIX (decisão por
 * INTEGRAÇÃO, não por cidade: cidades da mesma base herdam; base nova = nova
 * integração com a própria opção). `chave` vazia/null = modo copia-e-cola do
 * boleto (SGP/Asaas); preenchida = chave manual que o bot e o botão PIX do
 * atendente informam ao cliente.
 */
export async function updateIntegrationPix(id: string, chave: string | null): Promise<{ ok: boolean; message: string }> {
  parse(zUuid, id);
  const session = await getSession();
  if (!session?.organization) return { ok: false, message: "Sessão inválida." };
  if (!isAdmin(session.profile)) {
    return { ok: false, message: "Apenas administradores podem alterar o modo de PIX." };
  }
  const limpa = (chave ?? "").trim();
  if (limpa.length > 120) return { ok: false, message: "Chave PIX muito longa." };
  const { createClient } = await import("@/lib/supabase/server");
  const sb = await createClient();
  const { data } = await sb
    .from("integrations")
    .select("config")
    .eq("id", id)
    .eq("organization_id", session.organization.id)
    .single();
  if (!data) return { ok: false, message: "Integração não encontrada." };
  const config = { ...((data.config as Record<string, unknown>) ?? {}) };
  if (limpa) config.pix_chave_manual = limpa;
  else delete config.pix_chave_manual;
  const { error } = await sb.from("integrations").update({ config }).eq("id", id).eq("organization_id", session.organization.id);
  if (error) return { ok: false, message: "Falha ao salvar." };
  revalidatePath("/integracoes");
  return { ok: true, message: limpa ? `Modo chave manual ativado (${limpa}).` : "Modo copia-e-cola do boleto (SGP) ativado." };
}

/** Testa a conexão com a integração SGP. */
export async function testIntegration(id: string): Promise<{ ok: boolean; message: string }> {
  parse(zUuid, id);
  const session = await getSession();
  if (!session?.organization) return { ok: false, message: "Sessão inválida." };
  const { createClient } = await import("@/lib/supabase/server");
  const sb = await createClient();
  // Org check explícito — defesa-em-profundidade além da RLS.
  const { data } = await sb
    .from("integrations")
    .select("config")
    .eq("id", id)
    .eq("organization_id", session.organization.id)
    .single();
  if (!data) return { ok: false, message: "Integração não encontrada." };
  try {
    const { sgpFromConfig } = await import("@/lib/sgp");
    const client = sgpFromConfig(data.config);
    // Tenta listar tipos de ocorrência como health check (endpoint leve).
    const tipos = await client.listarTiposOcorrencia();
    return { ok: true, message: `Conexão OK! ${tipos.length} tipos de ocorrência encontrados.` };
  } catch (e) {
    return { ok: false, message: `Falha: ${(e as Error)?.message ?? "erro desconhecido"}` };
  }
}
