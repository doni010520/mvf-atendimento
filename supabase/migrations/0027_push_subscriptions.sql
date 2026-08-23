-- Notificações push (PWA / Web Push): um registro por APARELHO do atendente.
--
-- Enquanto esta migration não roda, o app guarda as inscrições em
-- organizations.settings.push_subs (ver src/lib/push/store.ts). Assim que a
-- tabela existir, o código passa a usá-la sozinho — não precisa deploy.
-- Depois de rodar, o bloco do fim migra o que estiver no jsonb.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,               -- URL do serviço de push (FCM/Apple/Mozilla)
  p256dh text not null,                        -- chave pública do aparelho
  auth text not null,                          -- segredo de autenticação do aparelho
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_push_subs_org_user
  on public.push_subscriptions(organization_id, user_id);

alter table public.push_subscriptions enable row level security;
-- Sem policies: só o service role (rotas /api/push/*) escreve/lê. As chaves de
-- um aparelho não devem ficar legíveis para os outros usuários da org.

-- Migra o que já estiver no fallback jsonb (idempotente).
insert into public.push_subscriptions (organization_id, user_id, endpoint, p256dh, auth, user_agent)
select
  o.id,
  (s->>'user_id')::uuid,
  s->>'endpoint',
  s->>'p256dh',
  s->>'auth',
  s->>'user_agent'
from public.organizations o
cross join lateral jsonb_array_elements(coalesce(o.settings->'push_subs', '[]'::jsonb)) as s
where s->>'endpoint' is not null
  and exists (select 1 from public.profiles p where p.id = (s->>'user_id')::uuid)
on conflict (endpoint) do nothing;

-- Opcional, depois de conferir que a tabela ficou populada:
-- update public.organizations set settings = settings - 'push_subs';
