"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Pencil, Trash2 } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import { PRESENCE_CHANNEL } from "@/components/presence-tracker";
import { createAgent, updateAgent, deleteAgent } from "@/app/(app)/atendentes/actions";
import type { Profile, Department } from "@/lib/types";

const ROLES = [
  { value: "admin", label: "Administrador" },
  { value: "supervisor", label: "Supervisor" },
  { value: "agent", label: "Atendente" },
];

export function AgentsClient({ agents, departments }: { agents: Profile[]; departments: Department[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"new" | "edit" | null>(null);
  const [current, setCurrent] = useState<Profile | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Presença REAL (quem está com o app aberto agora) — antes a bolinha vinha do
  // campo manual profiles.status e todo mundo aparecia offline mesmo logado.
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(PRESENCE_CHANNEL, { config: { presence: { key: `viewer` } } });
    ch.on("presence", { event: "sync" }, () => {
      setOnlineIds(new Set(Object.keys(ch.presenceState()).filter((k) => k !== "viewer")));
    }).subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  const deptName = (id: string | null) => departments.find((d) => d.id === id)?.name ?? "Sem departamento";

  async function submit(fd: FormData) {
    setPending(true);
    setError(null);
    try {
      if (mode === "edit" && current) await updateAgent(current.id, fd);
      else await createAgent(fd);
      setMode(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally {
      setPending(false);
    }
  }
  async function remove(a: Profile) {
    if (!confirm(`Excluir ${a.name || a.email}?`)) return;
    try {
      await deleteAgent(a.id);
      router.refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Erro ao excluir.");
    }
  }

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => { setMode("new"); setCurrent(null); }}>
          <Plus size={16} /> Novo atendente
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        {agents.length === 0 && <p className="py-10 text-center text-sm text-ink-soft">Nenhum atendente.</p>}
        {agents.map((a) => (
          <Card key={a.id} className="flex items-center gap-3 py-3">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600">
              {(a.name || a.email || "?").slice(0, 2).toUpperCase()}
              <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${onlineIds.has(a.id) ? "bg-green-500" : "bg-gray-400"}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{a.name || "(sem nome)"}</p>
              <p className="truncate text-xs text-ink-soft">{a.email} · {deptName(a.department_id)}</p>
            </div>
            <span className="rounded-full bg-brand-light px-2.5 py-1 text-xs font-medium text-brand">
              {ROLES.find((r) => r.value === a.role)?.label ?? a.role}
            </span>
            <button onClick={() => { setMode("edit"); setCurrent(a); }} className="rounded p-1.5 text-ink-soft hover:bg-gray-100 hover:text-ink"><Pencil size={15} /></button>
            <button onClick={() => remove(a)} className="rounded p-1.5 text-ink-soft hover:bg-red-50 hover:text-danger"><Trash2 size={15} /></button>
          </Card>
        ))}
      </div>

      {mode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-card bg-surface p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">{mode === "edit" ? "Editar atendente" : "Novo atendente"}</h2>
              <button onClick={() => setMode(null)} className="text-ink-soft hover:text-ink"><X size={18} /></button>
            </div>
            <form action={submit} className="space-y-3">
              <Inp name="name" label="Nome" defaultValue={current?.name} required />
              {mode === "new" && (
                <>
                  <Inp name="email" label="E-mail" type="email" required />
                  <Inp name="password" label="Senha (compartilhe com o atendente)" type="text" required placeholder="mín. 6 caracteres" />
                </>
              )}
              <Sel name="role" label="Nível de acesso" defaultValue={current?.role ?? "agent"} options={ROLES} />
              <Sel name="department_id" label="Departamento" defaultValue={current?.department_id ?? ""}
                options={[{ value: "", label: "Sem departamento" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]} />
              {/* O status Online/Offline agora é automático (presença real de
                  quem está com o app aberto) — o seletor manual saiu. */}
              {error && <p className="text-xs text-danger">{error}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => setMode(null)}>Cancelar</Button>
                <Button type="submit" disabled={pending}>{pending ? "Salvando..." : "Salvar"}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function Inp({ name, label, defaultValue, type = "text", required, placeholder }: { name: string; label: string; defaultValue?: string | null; type?: string; required?: boolean; placeholder?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink-soft">{label}</label>
      <input name={name} type={type} defaultValue={defaultValue ?? ""} required={required} placeholder={placeholder}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
    </div>
  );
}
function Sel({ name, label, defaultValue, options }: { name: string; label: string; defaultValue?: string; options: { value: string; label: string }[] }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink-soft">{label}</label>
      <select name={name} defaultValue={defaultValue} className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
