"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { changeOwnPassword } from "@/app/(app)/perfil/actions";

/**
 * Form de troca de senha OBRIGATÓRIA (primeiro acesso). Ao concluir, a flag
 * `must_change_password` é limpa dentro de changeOwnPassword e a pessoa é
 * levada de volta ao app (o layout então segue para o 2FA, se necessário).
 */
export function ForcedPasswordForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(fd: FormData) {
    setPending(true);
    setError(null);
    // A action RETORNA o erro (não lança): exceção de Server Action vira texto
    // técnico censurado em produção. O try/catch fica só para queda de rede.
    try {
      const r = await changeOwnPassword(fd);
      if (!r.ok) {
        setError(r.error);
        setPending(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Não foi possível falar com o servidor. Verifique a conexão e tente de novo.");
      setPending(false);
    }
  }

  const inputCls = "w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand";

  return (
    <form action={submit} className="mt-4 space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-soft">Nova senha</label>
        <input name="password" type="password" required minLength={6} autoFocus placeholder="Mínimo 6 caracteres" className={inputCls} />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-soft">Confirmar nova senha</label>
        <input name="password_confirm" type="password" required minLength={6} className={inputCls} />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Salvando…" : "Definir senha e continuar"}</Button>
    </form>
  );
}
