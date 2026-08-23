import { Scroll } from "@/components/scroll";
import { PageHeader, Card, Button } from "@/components/ui";
import { getSession } from "@/lib/auth";
import { PREVIEW_MODE } from "@/lib/mock";
import { updateOwnProfile } from "./actions";
import { TwoFactorSetup } from "@/components/two-factor-setup";
import { PasswordChangeForm } from "@/components/password-change-form";
import { PushToggle } from "@/components/push-toggle";

const ROLE_LABEL: Record<string, string> = { admin: "Administrador", supervisor: "Supervisor", agent: "Atendente" };

export default async function PerfilPage() {
  const session = PREVIEW_MODE ? null : await getSession();
  const p = session?.profile;
  // name guardado junto; separa em Nome / Sobrenome só para exibição no form.
  const parts = (p?.name ?? "").trim().split(/\s+/);
  const firstName = parts.shift() ?? "";
  const lastName = parts.join(" ");

  return (
    <Scroll>
      <PageHeader title="Meu perfil" subtitle="Seus dados pessoais e preferências." />
      <Card className="max-w-xl">
        <form action={updateOwnProfile} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-soft">Nome</label>
              <input name="name" defaultValue={firstName} className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-soft">Sobrenome</label>
              <input name="last_name" defaultValue={lastName} className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-soft">E-mail</label>
              <input value={p?.email ?? ""} disabled className="w-full rounded-lg border border-border bg-gray-50 px-3 py-2 text-sm text-ink-soft" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-soft">Nível de acesso</label>
              <input value={ROLE_LABEL[p?.role ?? "agent"] ?? ""} disabled className="w-full rounded-lg border border-border bg-gray-50 px-3 py-2 text-sm text-ink-soft" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-soft">WhatsApp</label>
              <input name="whatsapp" defaultValue={p?.whatsapp ?? ""} placeholder="DDD + número" className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-soft">Status</label>
              <select name="status" defaultValue={p?.status ?? "offline"} className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-brand">
                <option value="online">Online</option>
                <option value="away">Ausente</option>
                <option value="offline">Offline</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="notify" defaultChecked={p?.notify ?? true} className="h-4 w-4 rounded border-gray-300" />
            Receber notificações
          </label>
          <div className="pt-1">
            <Button type="submit">Salvar</Button>
          </div>
        </form>
      </Card>

      {!PREVIEW_MODE && <PushToggle className="max-w-xl" />}
      {!PREVIEW_MODE && <PasswordChangeForm />}
      {!PREVIEW_MODE && <TwoFactorSetup enabled={p?.totp_enabled} />}
    </Scroll>
  );
}
