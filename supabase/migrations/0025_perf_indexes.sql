-- =====================================================================
-- 0025 — Índices de performance para a view conversation_overview
-- A view faz 2 lateral joins por conversa: última mensagem não-interna e
-- contagem de não-lidas. Sem índice, com centenas de conversas isso varre
-- a tabela messages inteira por linha e a view chega a NÃO retornar (timeout),
-- travando todo o carregamento do atendimento. Estes índices parciais tornam
-- cada lateral um lookup rápido.
-- =====================================================================

-- Gargalo principal: count(*) das não-lidas (direction='in' e status<>'read').
-- Índice parcial só das não-lidas (conjunto pequeno) -> contagem instantânea.
create index if not exists idx_messages_unread
  on messages (conversation_id)
  where direction = 'in' and status <> 'read';

-- Última mensagem NÃO interna por conversa (o "order by created_at desc limit 1").
create index if not exists idx_messages_last_noninternal
  on messages (conversation_id, created_at desc)
  where coalesce(is_internal, false) = false;

analyze messages;
