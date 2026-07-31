import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Scroll } from "@/components/scroll";
import { PageHeader } from "@/components/ui";
import { CrudManager, type CrudField } from "@/components/crud-manager";
import { getAutoMessages } from "@/lib/data/management";
import { getChannels } from "@/lib/data/channels";
import { getDepartments } from "@/lib/data/management";
import { createAutoMessage, updateAutoMessage, deleteAutoMessage } from "./actions";

const EVENT_OPTIONS = [
  { value: "welcome", label: "Boas-vindas (nova conversa)" },
  { value: "away", label: "Ausência (atendente offline)" },
  { value: "out_of_hours", label: "Fora do horário de atendimento" },
  { value: "close", label: "Encerramento do atendimento" },
  { value: "queue_wait", label: "Fila de espera (reenvia periodicamente)" },
  { value: "agent_assign", label: "Atribuição de atendente" },
];

export default async function AutomaticasPage() {
  const [msgs, channels, departments] = await Promise.all([
    getAutoMessages(),
    getChannels(),
    getDepartments(),
  ]);

  const FIELDS: CrudField[] = [
    {
      name: "event", label: "Evento", type: "select", required: true, inList: true,
      options: EVENT_OPTIONS,
    },
    { name: "body", label: "Mensagem", type: "textarea", required: true, placeholder: "Olá! Bem-vindo ao nosso atendimento.",
      hint: "Variáveis (na Atribuição de atendente): @atendente_nome e @protocolo." },
    {
      name: "channel_id", label: "Canal (vazio = todos)", type: "select",
      options: channels.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      name: "department_id", label: "Departamento (vazio = todos)", type: "select",
      options: departments.map((d) => ({ value: d.id, label: d.name })),
    },
    { name: "interval_min", label: "Intervalo de reenvio (minutos)", type: "number", placeholder: "15 (só para fila de espera)" },
    { name: "active", label: "Ativa", type: "checkbox" },
  ];

  return (
    <Scroll>
      <Link href="/mensagens" className="mt-4 inline-flex items-center gap-1 text-sm text-brand hover:underline">
        <ArrowLeft size={15} /> Mensagens
      </Link>
      <PageHeader
        title="Mensagens Automáticas"
        subtitle="Mensagens enviadas automaticamente em momentos específicos do atendimento."
      />
      <CrudManager
        items={msgs.map((m) => ({
          ...m,
          _subtitle: `${m.active ? "Ativa" : "Inativa"}${m.interval_min ? ` · a cada ${m.interval_min} min` : ""}`,
        }))}
        fields={FIELDS}
        createAction={createAutoMessage}
        updateAction={updateAutoMessage}
        deleteAction={deleteAutoMessage}
        addLabel="Nova mensagem automática"
        emptyTitle="Nenhuma mensagem automática"
      />
    </Scroll>
  );
}
