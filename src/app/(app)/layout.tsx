import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { Toaster } from "@/components/toast";
import { VersionWatcher } from "@/components/version-watcher";
import { PresenceTracker } from "@/components/presence-tracker";
import { getSession, isAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const hasEnv = !!process.env.NEXT_PUBLIC_SUPABASE_URL;

  let userName = "ADONIAS SOUZA";
  let orgName = "Modo preview";
  let email: string | undefined;
  let userId: string | null = null;
  let admin = true; // preview: mostra tudo

  if (hasEnv) {
    const session = await getSession();
    if (!session) redirect("/login");
    if (!session.organization) redirect("/onboarding");

    // Senha provisória: força a troca no primeiro acesso, antes de tudo.
    if (session.mustChangePassword) redirect("/trocar-senha");

    // 2FA obrigatório por PADRÃO para todos os usuários não isentos. Quem ainda
    // não está em AAL2 é mandado para /2fa (cadastrar ou validar o código).
    // Isentos: DEFAULT_EXEMPT (dono + revisor) + MFA_EXEMPT_EMAILS.
    // Off-switch: definir REQUIRE_2FA=false desliga a exigência globalmente.
    if (process.env.REQUIRE_2FA !== "false") {
      // Isenções padrão (garantidas mesmo sem a env): dono do app + revisor da Meta.
      // Pode remover depois (ex.: após a aprovação da Meta) se quiser exigir 2FA deles.
      const DEFAULT_EXEMPT = ["admin@mvf.com.br", "revisor@benitechlab.com"];
      const exempt = [
        ...DEFAULT_EXEMPT,
        ...(process.env.MFA_EXEMPT_EMAILS ?? "").split(","),
      ].map((s) => s.trim().toLowerCase()).filter(Boolean);
      const emailLc = (session.profile?.email ?? "").toLowerCase();
      if (!emailLc || !exempt.includes(emailLc)) {
        let needs2fa = false;
        try {
          const sb = await createClient();
          const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
          needs2fa = !!aal && aal.currentLevel !== "aal2";
        } catch {
          // Fail-open: erro transitório não deve trancar o app.
          needs2fa = false;
        }
        if (needs2fa) redirect("/2fa"); // fora do try — redirect lança NEXT_REDIRECT
      }
    }

    userName = session.profile?.name || session.profile?.email || "Usuário";
    orgName = session.organization.name;
    email = session.profile?.email ?? undefined;
    userId = session.userId ?? null;
    admin = isAdmin(session.profile);
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar isAdmin={admin} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar userName={userName} orgName={orgName} email={email} userId={userId} />
        {!hasEnv && (
          <div className="mx-6 mb-2 rounded-lg bg-amber-100 px-4 py-2 text-xs text-amber-800">
            Modo preview — Supabase não configurado. Crie o projeto e preencha o{" "}
            <code>.env.local</code> para ativar login e dados reais.
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
      <Toaster />
      <VersionWatcher />
      <PresenceTracker userId={userId} />
    </div>
  );
}
