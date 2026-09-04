-- Quadro de melhorias e falhas (mesmo design do correa-atendimento, em produção
-- desde 01/09/26 — ver docs da spec lá: 2026-09-01-quadro-melhorias-design.md).
--
-- A equipe relatava problema do sistema por WhatsApp, no meio do fluxo de
-- atendimento, e o relato se perdia: ninguém sabia se tinha sido visto e o mesmo
-- bug chegava duas vezes por pessoas diferentes. Esta tabela é onde o relato passa
-- a morar.
--
-- Sem prioridade, sem responsável, sem prazo e sem comentários DE PROPÓSITO:
-- campo que ninguém preenche vira ruído.

create table if not exists feedback_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  tipo            text not null check (tipo in ('falha', 'melhoria')),
  status          text not null default 'novo'
                    check (status in ('novo', 'analisando', 'resolvendo', 'concluido')),
  titulo          text not null,
  descricao       text,
  print_url       text,
  -- Guardado além da URL pública: não há exclusão de card nesta versão, mas uma
  -- faxina futura de arquivos órfãos não vai precisar adivinhar o path pela URL.
  print_path      text,
  -- SET NULL: atendente desligada não apaga o relato dela.
  criado_por      uuid references profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  -- Quando o status mudou pela última vez. É o que permite mostrar "parado há
  -- 3 dias" sem manter tabela de histórico.
  status_em       timestamptz not null default now()
);

create index if not exists feedback_items_org_status_idx
  on feedback_items (organization_id, status, created_at desc);

alter table feedback_items enable row level security;

create policy feedback_items_all on feedback_items
  for all
  using (organization_id = current_org_id())
  with check (organization_id = current_org_id());
