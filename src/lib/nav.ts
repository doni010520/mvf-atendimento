import {
  LayoutDashboard,
  BarChart3,
  MessageSquareText,
  LayoutGrid,
  Radio,
  Bot,
  Megaphone,
  Users,
  Layers,
  Settings,
  Plug,
  Tag,
  Building2,
  Contact,
  Sparkles,
  ClipboardList,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Item visível apenas para administradores. */
  adminOnly?: boolean;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    title: "Geral",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/relatorios", label: "Relatórios", icon: BarChart3 },
    ],
  },
  {
    title: "Atendimento",
    items: [
      { href: "/canais", label: "Canais", icon: Radio },
      { href: "/atendimento", label: "Atendimento", icon: MessageSquareText },
      { href: "/atendimento-v2", label: "Atendimento V2", icon: LayoutGrid },
      { href: "/mensagens", label: "Mensagens", icon: Tag },
      { href: "/automacoes", label: "Automações", icon: Bot },
      { href: "/ajustes/ia", label: "Agente de IA", icon: Sparkles, adminOnly: true },
      { href: "/campanhas", label: "Campanhas", icon: Megaphone },
    ],
  },
  {
    title: "Empresa",
    items: [
      { href: "/empresa", label: "Dados da empresa", icon: Building2 },
      { href: "/atendentes", label: "Atendentes", icon: Users },
      { href: "/departamentos", label: "Departamentos", icon: Layers },
      { href: "/clientes", label: "Clientes", icon: Contact },
      { href: "/melhorias", label: "Melhorias e falhas", icon: ClipboardList },
      { href: "/integracoes", label: "SGP", icon: Plug },
      { href: "/ajustes", label: "Ajustes", icon: Settings },
    ],
  },
];

export const ALL_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);
