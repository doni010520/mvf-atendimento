"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth";

export async function updateOwnProfile(fd: FormData) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error("Configure o Supabase.");
  const session = await getSession();
  if (!session) throw new Error("Sessão inválida.");
  const sb = await createClient();
  // Nome + sobrenome são dois campos na UI, mas guardados juntos em profiles.name.
  const first = String(fd.get("name") || "").trim();
  const last = String(fd.get("last_name") || "").trim();
  const fullName = [first, last].filter(Boolean).join(" ");
  const { error } = await sb
    .from("profiles")
    .update({
      name: fullName,
      whatsapp: String(fd.get("whatsapp") || "").replace(/\D/g, "") || null,
      status: String(fd.get("status") || "offline"),
      notify: fd.get("notify") === "on",
    })
    .eq("id", session.userId);
  if (error) throw new Error(error.message);
  revalidatePath("/perfil");
}

/** Troca a senha do próprio usuário (sessão atual). */
export type ChangePasswordResult = { ok: true } | { ok: false; error: string };

/** Traduz os erros do Supabase que a pessoa realmente pode resolver sozinha. */
function motivoSenha(bruto: string): string {
  const m = bruto.toLowerCase();
  if (m.includes("different from the old")) return "A nova senha precisa ser diferente da atual.";
  if (m.includes("at least") || m.includes("too short")) return "A senha é curta demais. Use pelo menos 6 caracteres.";
  if (m.includes("weak") || m.includes("pwned")) return "Essa senha é fácil de adivinhar. Escolha outra.";
  if (m.includes("session") || m.includes("jwt")) return "Sua sessão expirou. Entre novamente e refaça a troca.";
  return bruto;
}

/**
 * Troca a senha da própria conta.
 *
 * RETORNA o erro em vez de lançar: o Next.js CENSURA exceções de Server Action
 * em produção, trocando a mensagem por "An error occurred in the Server
 * Components render...". Ou seja, quem lançava "As senhas não coincidem" fazia
 * a pessoa ver um texto técnico que não diz nada — e ficar sem saber o que
 * corrigir. (Caso real: 27/08/2026, na tela de senha provisória.)
 */
export async function changeOwnPassword(fd: FormData): Promise<ChangePasswordResult> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return { ok: false, error: "Supabase não configurado." };
  const session = await getSession();
  if (!session) return { ok: false, error: "Sua sessão expirou. Entre novamente e refaça a troca." };
  const password = String(fd.get("password") || "");
  const confirm = String(fd.get("password_confirm") || "");
  if (password.length < 6) return { ok: false, error: "A senha deve ter no mínimo 6 caracteres." };
  if (password !== confirm) return { ok: false, error: "As senhas não coincidem." };
  const sb = await createClient();
  // Troca a senha E limpa a flag de senha provisória (caso seja o 1º acesso).
  const { error } = await sb.auth.updateUser({ password, data: { must_change_password: false } });
  if (error) return { ok: false, error: motivoSenha(error.message) };
  return { ok: true };
}

/** Sincroniza o flag profiles.totp_enabled (chamado pelo componente de 2FA). */
export async function setTotpEnabled(enabled: boolean) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
  const session = await getSession();
  if (!session) return;
  const sb = await createClient();
  await sb.from("profiles").update({ totp_enabled: enabled }).eq("id", session.userId);
  revalidatePath("/perfil");
}
