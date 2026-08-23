import Link from "next/link";
import {
  SlidersHorizontal, Users, Plug, Star, Bookmark, Tag, UserCog,
  Layers, ScrollText, Bot, ClipboardList, ArrowUpRight, Clock,
} from "lucide-react";
import { Scroll } from "@/components/scroll";
import { PageHeader } from "@/components/ui";
import { getSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PREVIEW_MODE } from "@/lib/mock";
import { PushToggle } from "@/components/push-toggle";

const CARDS = [
  { icon: SlidersHorizontal, title: "Configurações", desc: "Descubra a melhor maneira de usar o chat!", href: "/ajustes/configuracoes" },
  { icon: Users, title: "Usuários", desc: "Gerencie os usuários, departamentos e permissões.", href: "/atendentes" },
  { icon: Plug, title: "Integrações", desc: "Gerencie as integrações do sistema!", href: "/integracoes" },
  { icon: Star, title: "Pesquisa de Satisfação", desc: "Colha informações valiosas sobre o atendimento.", href: "/ajustes/satisfacao" },
  { icon: Bookmark, title: "Classificação de Atendimento", desc: "Tags para classificar seus atendimentos.", href: "/ajustes/tags?scope=conversation" },
  { icon: Tag, title: "Classificação de Clientes", desc: "Classifique seus clientes conforme a necessidade.", href: "/ajustes/tags?scope=contact" },
  { icon: UserCog, title: "Classificação de Status", desc: "Status que os atendentes podem assumir.", href: "/ajustes/tags?scope=status" },
  { icon: Layers, title: "Departamentos", desc: "Atualize os departamentos da sua empresa.", href: "/departamentos" },
  { icon: ScrollText, title: "Logs", desc: "Verifique o histórico do seu sistema!", href: "/auditoria" },
  { icon: Bot, title: "Agente de IA", desc: "Acesse o seu agente de IA.", href: "/ajustes/ia" },
  { icon: ClipboardList, title: "Planos", desc: "Gerencie os planos do seu provedor.", href: "/ajustes/planos" },
  { icon: Clock, title: "Horário de Atendimento", desc: "Defina os dias e horários de funcionamento.", href: "/ajustes/horario" },
];

export default async function AjustesPage() {
  // Esconde o módulo de IA para usuários marcados (ex.: revisor da Meta) e para
  // não-administradores (configurar o agente de IA é restrito a admin).
  let hideAi = false;
  let admin = true;
  if (!PREVIEW_MODE) {
    const session = await getSession();
    if (session?.userId) {
      const sb = await createClient();
      const { data: me } = await sb
        .from("profiles")
        .select("hide_ai, role, super_admin")
        .eq("id", session.userId)
        .maybeSingle();
      const p = me as { hide_ai?: boolean; role?: string; super_admin?: boolean } | null;
      hideAi = !!p?.hide_ai;
      admin = p?.role === "admin" || !!p?.super_admin;
    }
  }
  const cards = hideAi || !admin ? CARDS.filter((c) => c.href !== "/ajustes/ia") : CARDS;

  return (
    <Scroll>
      <PageHeader title="Ajustes" subtitle="Acesse e ajuste os módulos de acordo com suas necessidades." />
      <PushToggle className="mb-4" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {cards.map(({ icon: Icon, title, desc, href }) => (
          <Link
            key={title}
            href={href}
            className="group flex items-start gap-4 rounded-card bg-surface p-5 shadow-sm transition hover:shadow-md"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-light text-brand">
              <Icon size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-brand">{title}</h3>
              <p className="mt-0.5 text-xs text-ink-soft">{desc}</p>
            </div>
            <ArrowUpRight size={18} className="text-gray-300 transition group-hover:text-brand" />
          </Link>
        ))}
      </div>
    </Scroll>
  );
}
