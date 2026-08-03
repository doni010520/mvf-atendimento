-- =====================================================================
-- 0026 — Oferecer atendimento para VÁRIOS colegas (o primeiro assume)
-- offered_to = lista de atendentes a quem a conversa foi oferecida.
-- Regra de visibilidade (app): conversa SEM dono aparece p/ o atendente se
-- offered_to é vazio (fila geral) OU o atendente está em offered_to.
-- Ao assumir/responder, offered_to é limpo (sai da tela dos outros).
-- =====================================================================

alter table conversations add column if not exists offered_to uuid[];

-- Recria a view expondo offered_to (mantém tudo o que já existia).
drop view if exists conversation_overview;
create view conversation_overview
with (security_invoker = true)
as
select
  c.id, c.organization_id, c.status, c.assigned_user_id, c.department_id,
  c.channel_id, c.contact_id, c.protocol, c.last_message_at, c.opened_at,
  c.closed_at, c.created_at, c.is_muted, c.satisfaction, c.close_reason,
  c.bot_automation_id, c.survey_id, c.pinned, c.archived,
  c.awaiting_satisfaction, c.closed_by, c.ai_enabled, c.offered_to,
  ct.name as contact_name, ct.phone as contact_phone, ct.avatar_url as contact_avatar,
  ct.is_group as is_group, ct.chat_jid as contact_jid,
  ct.email as contact_email, ct.city as contact_city,
  ch.name as channel_name, ch.type as channel_type,
  pr.name as assigned_name,
  dp.name as department_name, dp.color as department_color,
  lm.body as last_message_body, lm.content_type as last_message_type,
  lm.direction as last_message_direction, lm.author_name as last_message_author,
  lm.created_at as last_message_created_at,
  coalesce(ur.cnt, 0)::int as unread_count
from conversations c
join contacts ct on ct.id = c.contact_id
join channels ch on ch.id = c.channel_id
left join profiles pr on pr.id = c.assigned_user_id
left join departments dp on dp.id = c.department_id
left join lateral (
  select body, content_type, direction, author_name, created_at
  from messages m
  where m.conversation_id = c.id and coalesce(m.is_internal, false) = false
  order by m.created_at desc
  limit 1
) lm on true
left join lateral (
  select count(*) as cnt
  from messages m2
  where m2.conversation_id = c.id and m2.direction = 'in' and m2.status <> 'read'
) ur on true;
