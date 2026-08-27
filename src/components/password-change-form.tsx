"use client";

import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { changeOwnPassword } from "@/app/(app)/perfil/actions";

export function PasswordChangeForm() {
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(fd: FormData) {
    setPending(true);
    setMsg(null);
    // A action RETORNA o erro (não lança): exceção de Server Action vira texto
    // técnico censurado em produção. O try/catch fica só para queda de rede.
    try {
      const r = await changeOwnPassword(fd);
      if (!r.ok) {
        setMsg({ ok: false, text: r.error });
        return;
      }
      setMsg({ ok: true, text: "Senha alterada com sucesso." });
      (document.getElementById("pwd-form") as HTMLFormElement | null)?.reset();
    } catch {
      setMsg({ ok: false, text: "Não foi possível falar com o servidor. Verifique a conexão e tente de novo." });
    } finally {
      setPending(false);
    }
  }

  const inputCls = "w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand";

  return (
    <Card className="mt-4 max-w-xl">
      <h3 className="mb-3 text-sm font-semibold text-ink">Alterar senha</h3>
      <form id="pwd-form" action={submit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">Nova senha</label>
            <input name="password" type="password" required minLength={6} placeholder="Mínimo 6 caracteres" className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">Confirmar nova senha</label>
            <input name="password_confirm" type="password" required minLength={6} className={inputCls} />
          </div>
        </div>
        {msg && <p className={`text-xs ${msg.ok ? "text-green-600" : "text-danger"}`}>{msg.text}</p>}
        <Button type="submit" disabled={pending}>{pending ? "Salvando…" : "Alterar senha"}</Button>
      </form>
    </Card>
  );
}
