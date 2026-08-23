"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2, Share, Smartphone } from "lucide-react";
import { Card, Button } from "@/components/ui";
import {
  disablePush,
  enablePush,
  getPushState,
  isIOS,
  isStandalone,
  type PushState,
} from "@/lib/push-client";

/**
 * "Notificações neste aparelho" — o card que liga o push.
 *
 * É POR APARELHO, não por conta: a inscrição de push pertence ao navegador
 * daquele celular. Quem usa o app no celular e no computador precisa ativar nos
 * dois. O texto do card diz isso, porque a primeira dúvida do atendente é
 * exatamente essa.
 */
export function PushToggle({ className }: { className?: string }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [iosSemInstalar, setIosSemInstalar] = useState(false);

  useEffect(() => {
    let alive = true;
    getPushState().then((s) => {
      if (!alive) return;
      setState(s);
      setIosSemInstalar(isIOS() && !isStandalone());
    });
    return () => {
      alive = false;
    };
  }, []);

  async function ligar() {
    setBusy(true);
    setMsg(null);
    const res = await enablePush();
    setState(res.state);
    setMsg(res.ok ? "Pronto — este aparelho vai avisar quando chegar mensagem." : (res.error ?? "Não foi possível ativar."));
    setBusy(false);
  }

  async function testar() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; sent?: number };
      setMsg(
        data.ok && (data.sent ?? 0) > 0
          ? "Enviado. A notificação deve aparecer em alguns segundos — se o app estiver aberto na frente, minimize para ver."
          : "Nada foi enviado: este aparelho não está registrado. Desligue e ative de novo.",
      );
    } catch {
      setMsg("Não foi possível enviar o teste agora.");
    }
    setBusy(false);
  }

  async function desligar() {
    setBusy(true);
    setMsg(null);
    setState(await disablePush());
    setMsg("Notificações desligadas neste aparelho.");
    setBusy(false);
  }

  // Enquanto não sabemos o estado, não pisca nada na tela.
  if (state === null) return null;

  const ligado = state === "on";

  return (
    <Card className={className}>
      <div className="flex items-start gap-4">
        <div
          className={
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg " +
            (ligado ? "bg-brand-light text-brand" : "bg-gray-100 text-ink-soft")
          }
        >
          {ligado ? <Bell size={20} /> : <BellOff size={20} />}
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-ink">Notificações neste aparelho</h3>
          <p className="mt-0.5 text-xs text-ink-soft">
            Avisa quando chegar mensagem de um atendimento seu ou da fila — mesmo com o app fechado.
            A configuração vale só para <strong>este</strong> aparelho.
          </p>

          {state === "unsupported" && (
            <p className="mt-3 text-xs text-ink-soft">
              Este navegador não suporta notificações. Use o Chrome (Android) ou o Safari (iPhone).
            </p>
          )}

          {state === "denied" && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              As notificações estão <strong>bloqueadas</strong> para este site. Libere nas permissões do
              navegador (cadeado ao lado do endereço → Notificações) e recarregue a página.
            </p>
          )}

          {iosSemInstalar && state !== "unsupported" && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <Share size={14} className="mt-0.5 shrink-0" />
              <span>
                No iPhone, notificação só funciona com o app instalado: toque em <strong>Compartilhar</strong> →{" "}
                <strong>Adicionar à Tela de Início</strong> e abra o MVF Chat por lá.
              </span>
            </p>
          )}

          {msg && <p className="mt-3 text-xs text-ink-soft">{msg}</p>}

          {state !== "unsupported" && state !== "denied" && (
            <div className="mt-4">
              {ligado ? (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={testar} disabled={busy}>
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <Bell size={16} />}
                    Enviar teste
                  </Button>
                  <Button variant="ghost" onClick={desligar} disabled={busy}>
                    <BellOff size={16} />
                    Desligar aqui
                  </Button>
                </div>
              ) : (
                <Button onClick={ligar} disabled={busy || iosSemInstalar}>
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Smartphone size={16} />}
                  Ativar neste aparelho
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
