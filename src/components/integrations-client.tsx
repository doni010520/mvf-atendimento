"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Trash2, Plug, CheckCircle2, AlertCircle, QrCode } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { createIntegration, deleteIntegration, testIntegration, updateIntegrationPix } from "@/app/(app)/integracoes/actions";
import type { Integration } from "@/lib/types";

export function IntegrationsClient({ integrations }: { integrations: Integration[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // Modal "Pagamento PIX" da unidade (por INTEGRAÇÃO, não por cidade — cidades
  // da mesma base SGP herdam; unidade nova = nova integração com a opção junto).
  const [pixFor, setPixFor] = useState<Integration | null>(null);
  const [pixMode, setPixMode] = useState<"boleto" | "manual">("boleto");
  const [pixChave, setPixChave] = useState("");
  const [pixSaving, setPixSaving] = useState(false);

  function openPix(it: Integration) {
    const chave = String((it.config as { pix_chave_manual?: string })?.pix_chave_manual ?? "").trim();
    setPixMode(chave ? "manual" : "boleto");
    setPixChave(chave);
    setPixFor(it);
  }
  async function savePix() {
    if (!pixFor) return;
    if (pixMode === "manual" && !pixChave.trim()) { alert("Informe a chave PIX."); return; }
    setPixSaving(true);
    try {
      const r = await updateIntegrationPix(pixFor.id, pixMode === "manual" ? pixChave.trim() : null);
      alert(r.message);
      if (r.ok) { setPixFor(null); router.refresh(); }
    } finally { setPixSaving(false); }
  }

  async function submit(fd: FormData) {
    setPending(true);
    try { await createIntegration(fd); setOpen(false); router.refresh(); }
    finally { setPending(false); }
  }
  async function remove(id: string) { if (!confirm("Excluir integração?")) return; await deleteIntegration(id); router.refresh(); }

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}><Plus size={16} /> Cadastrar</Button>
      </div>

      <div className="mt-4 space-y-2">
        {integrations.length === 0 && <p className="py-10 text-center text-sm text-ink-soft">Nenhuma integração de telefonia encontrada.</p>}
        {integrations.map((it) => (
          <Card key={it.id} className="flex items-center gap-3 py-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-light text-brand"><Plug size={18} /></div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium uppercase text-ink">{it.type}</p>
              <p className="truncate text-xs text-ink-soft">{String((it.config as { url?: string })?.url ?? "")}</p>
              <p className="truncate text-[11px] text-ink-soft">
                PIX:{" "}
                {String((it.config as { pix_chave_manual?: string })?.pix_chave_manual ?? "").trim() ? (
                  <span className="font-medium text-amber-700">chave manual — {String((it.config as { pix_chave_manual?: string }).pix_chave_manual)}</span>
                ) : (
                  <span className="font-medium text-green-700">copia-e-cola do boleto (SGP)</span>
                )}
              </p>
            </div>
            <button onClick={() => openPix(it)} className="rounded p-1.5 text-ink-soft hover:bg-brand-light hover:text-brand" title="Pagamento PIX desta unidade">
              <QrCode size={15} />
            </button>
            <button onClick={async () => {
              const r = await testIntegration(it.id);
              alert(r.message);
            }} className="rounded p-1.5 text-ink-soft hover:bg-green-50 hover:text-green-600" title="Testar conexão">
              <CheckCircle2 size={15} />
            </button>
            <button onClick={() => remove(it.id)} className="rounded p-1.5 text-ink-soft hover:bg-red-50 hover:text-danger"><Trash2 size={15} /></button>
          </Card>
        ))}
      </div>

      {pixFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-card bg-surface p-6 shadow-xl">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">Pagamento PIX da unidade</h2>
              <button onClick={() => setPixFor(null)} className="text-ink-soft hover:text-ink"><X size={18} /></button>
            </div>
            <p className="mb-4 truncate text-xs text-ink-soft">{String((pixFor.config as { url?: string })?.url ?? "")}</p>
            <div className="space-y-2">
              <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${pixMode === "boleto" ? "border-brand bg-brand-light/40" : "border-border"}`}>
                <input type="radio" name="pixmode" checked={pixMode === "boleto"} onChange={() => setPixMode("boleto")} className="mt-0.5" />
                <span>
                  <span className="font-medium text-ink">Copia-e-cola do boleto (SGP/Asaas)</span>
                  <span className="block text-xs text-ink-soft">O cliente recebe o código PIX gerado pelo próprio boleto — pagamento dá baixa automática. Recomendado.</span>
                </span>
              </label>
              <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${pixMode === "manual" ? "border-brand bg-brand-light/40" : "border-border"}`}>
                <input type="radio" name="pixmode" checked={pixMode === "manual"} onChange={() => setPixMode("manual")} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink">Chave PIX manual</span>
                  <span className="block text-xs text-ink-soft">O cliente recebe esta chave para transferir (sem baixa automática — o financeiro confere pelo comprovante).</span>
                  {pixMode === "manual" && (
                    <input
                      value={pixChave}
                      onChange={(e) => setPixChave(e.target.value)}
                      placeholder="CNPJ, celular, e-mail ou chave aleatória"
                      className="mt-2 w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  )}
                </span>
              </label>
            </div>
            <p className="mt-3 text-[11px] text-ink-soft">
              Vale para TODOS os clientes localizados nesta unidade SGP (todas as cidades dela). O robô e o botão PIX do atendente seguem esta configuração na hora.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setPixFor(null)}>Cancelar</Button>
              <Button onClick={savePix} disabled={pixSaving}>{pixSaving ? "Salvando..." : "Salvar"}</Button>
            </div>
          </div>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-card bg-surface p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">Nova integração</h2>
              <button onClick={() => setOpen(false)} className="text-ink-soft hover:text-ink"><X size={18} /></button>
            </div>
            <form action={submit} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-soft">Tipo</label>
                <select name="type" className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand">
                  <option value="sgp">SGP (provedor)</option>
                  <option value="outro">Outro</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-soft">URL</label>
                <input name="url" required placeholder="https://seudominio.sgp.net.br" className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-soft">Aplicação (app)</label>
                <input name="app" placeholder="nome da aplicação de integração" className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-soft">Token</label>
                <input name="token" className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-soft">Usuário <span className="text-ink-soft/60">(opcional)</span></label>
                  <input name="username" autoComplete="off" className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-soft">Senha <span className="text-ink-soft/60">(opcional)</span></label>
                  <input name="password" type="password" autoComplete="new-password" className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
                <Button type="submit" disabled={pending}>{pending ? "Salvando..." : "Cadastrar"}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
