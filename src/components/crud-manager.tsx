"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Pencil, Trash2 } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { toast } from "@/components/toast";

export type CrudField = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "color" | "select" | "number" | "checkbox" | "multiselect";
  options?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  inList?: boolean; // exibe no resumo da linha
  hint?: string; // dica exibida abaixo do campo (ex.: variáveis disponíveis)
};

type Item = Record<string, any> & { id: string };

export function CrudManager({
  items,
  fields,
  createAction,
  updateAction,
  deleteAction,
  addLabel = "Cadastrar",
  emptyTitle = "Nenhum item ainda",
  emptyHint,
}: {
  items: Item[];
  fields: CrudField[];
  createAction: (fd: FormData) => Promise<unknown>;
  updateAction: (id: string, fd: FormData) => Promise<unknown>;
  deleteAction: (id: string) => Promise<unknown>;
  addLabel?: string;
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const colorField = fields.find((f) => f.type === "color");
  const primary = fields[0];
  const secondary = fields.find((f) => f.inList && f.name !== primary.name);

  async function submit(fd: FormData) {
    setPending(true);
    setError(null);
    try {
      if (editing) await updateAction(editing.id, fd);
      else await createAction(fd);
      setEditing(null);
      setCreating(false);
      toast("Salvo com sucesso!");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally {
      setPending(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Tem certeza que deseja excluir?")) return;
    await deleteAction(id);
    router.refresh();
  }

  const open = creating || editing;

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => { setCreating(true); setEditing(null); }}>
          <Plus size={16} /> {addLabel}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="mt-4 flex flex-col items-center justify-center rounded-card border border-dashed border-gray-300 py-16 text-center">
          <p className="text-sm font-medium text-ink">{emptyTitle}</p>
          {emptyHint && <p className="mt-1 text-xs text-ink-soft">{emptyHint}</p>}
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {items.map((it) => (
            <Card key={it.id} className="flex items-center gap-3 py-3">
              {colorField && (
                <span
                  className="h-4 w-4 shrink-0 rounded-full"
                  style={{ background: it[colorField.name] || "#cbd5e1" }}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{it[primary.name]}</p>
                {secondary && (
                  <p className="truncate text-xs text-ink-soft">
                    {labelFor(secondary, it[secondary.name])}
                  </p>
                )}
              </div>
              <button onClick={() => { setEditing(it); setCreating(false); }} className="rounded p-1.5 text-ink-soft hover:bg-gray-100 hover:text-ink" title="Editar">
                <Pencil size={15} />
              </button>
              <button onClick={() => remove(it.id)} className="rounded p-1.5 text-ink-soft hover:bg-red-50 hover:text-danger" title="Excluir">
                <Trash2 size={15} />
              </button>
            </Card>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-card bg-surface p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">{editing ? "Editar" : addLabel}</h2>
              <button onClick={() => { setEditing(null); setCreating(false); }} className="text-ink-soft hover:text-ink">
                <X size={18} />
              </button>
            </div>
            <form action={submit} className="space-y-4">
              {fields.map((f) => (
                <div key={f.name}>
                  <label className="mb-1 block text-xs font-medium text-ink-soft">{f.label}</label>
                  {f.type === "textarea" ? (
                    <textarea name={f.name} defaultValue={editing?.[f.name] ?? ""} placeholder={f.placeholder} required={f.required}
                      rows={3} className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
                  ) : f.type === "select" ? (
                    <select name={f.name} defaultValue={editing?.[f.name] ?? ""} required={f.required}
                      className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand">
                      <option value="">—</option>
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.type === "multiselect" ? (
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                      {(f.options ?? []).length === 0 && (
                        <p className="px-1 py-1 text-xs text-ink-soft">Nenhuma opção disponível.</p>
                      )}
                      {f.options?.map((o) => {
                        const cur = editing?.[f.name];
                        const checked = Array.isArray(cur) ? cur.includes(o.value) : false;
                        return (
                          <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm">
                            <input type="checkbox" name={f.name} value={o.value} defaultChecked={checked} className="h-4 w-4 accent-brand" />
                            <span className="text-ink">{o.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : f.type === "checkbox" ? (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" name={f.name} defaultChecked={!!editing?.[f.name]} className="h-4 w-4 accent-brand" />
                      <span className="text-sm text-ink">{f.placeholder ?? "Ativo"}</span>
                    </label>
                  ) : f.type === "number" ? (
                    <input type="number" name={f.name} defaultValue={editing?.[f.name] ?? ""} placeholder={f.placeholder} required={f.required}
                      className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
                  ) : f.type === "color" ? (
                    <input type="color" name={f.name} defaultValue={editing?.[f.name] ?? "#00a8ff"}
                      className="h-10 w-20 cursor-pointer rounded-lg border border-border" />
                  ) : (
                    <input name={f.name} defaultValue={editing?.[f.name] ?? ""} placeholder={f.placeholder} required={f.required}
                      className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
                  )}
                  {f.hint && <p className="mt-1 text-[11px] text-ink-soft">{f.hint}</p>}
                </div>
              ))}
              {error && <p className="text-xs text-danger">{error}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => { setEditing(null); setCreating(false); }}>Cancelar</Button>
                <Button type="submit" disabled={pending}>{pending ? "Salvando..." : "Salvar"}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function labelFor(field: CrudField, value: unknown): string {
  if (field.type === "select") {
    return String(field.options?.find((o) => o.value === value)?.label ?? value ?? "—");
  }
  return String(value ?? "—");
}
