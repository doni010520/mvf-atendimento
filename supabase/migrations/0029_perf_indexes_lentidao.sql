-- =====================================================================
-- 0029 — Índices da investigação de lentidão de 26/08/2026
--
-- Contexto: mesmo depois de o Realtime voltar (ver 0028), a operação seguiu
-- relatando "chat super lento". pg_stat_statements mostrou UMA query com 83%
-- de todo o tempo de banco. Não era CPU da VPS nem tamanho da instância: o
-- banco estava consumindo o equivalente a ~2,7 núcleos numa instância Micro,
-- ou seja, permanentemente saturado. Depois destes dois índices caiu para
-- ~0,16 núcleo.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) A LISTA DE ENCERRADAS (a causa da lentidão)
--
-- getConversations() busca as 150 conversas encerradas mais recentes. O
-- PostgREST emite:
--
--   ORDER BY last_message_at DESC NULLS LAST
--
-- Nenhum índice existente casava com isso:
--   idx_conversations_org_status_lastmsg              -> ASC
--   conversations_organization_id_status_last_message -> DESC (= NULLS FIRST)
--
-- E o NULLS LAST não é detalhe: 246 conversas encerradas têm last_message_at
-- nulo, então a posição delas muda o resultado.
--
-- Sem índice para a ordem, o Postgres era obrigado a calcular os DOIS lateral
-- joins da view conversation_overview para TODAS as 8.390 encerradas, ordenar
-- e descartar 8.240. A cada 8 segundos, por atendente.
--
--   antes:  1.672 ms, loops=8390   (sob RLS real, como o app roda)
--   depois:    11,9 ms, loops=150
--   em produção, média real: 2.113 ms -> 56,6 ms
--
-- O ganho não é só a constante: a query deixou de escalar com o tamanho da
-- tabela. Passou a custar O(150) em vez de O(conversas encerradas).
-- ---------------------------------------------------------------------
create index if not exists idx_conversations_status_lastmsg_desc
  on conversations (organization_id, status, last_message_at desc nulls last);


-- ---------------------------------------------------------------------
-- 2) STATUS DE ENTREGA NO WEBHOOK (correção preventiva)
--
-- Quatro pontos em src/lib/whatsapp/inbound.ts casam o id externo assim:
--
--   .or(`external_id.eq.${id},external_id.ilike.%${tail}`)
--
-- Curinga à ESQUERDA não usa índice btree. O plano confirmava
-- "Rows Removed by Filter: 102552" — varredura completa de messages.
--
-- Dois desses pontos estão no processamento de status de entrega
-- (sent -> delivered -> read), ou seja ~4.000 varreduras completas por dia,
-- DENTRO do caminho do webhook. Ainda não tinha dado problema (117 ms), mas
-- escala linear com a tabela, que cresce ~3.500 linhas/dia:
--
--   hoje (102 mil)      117 ms
--   +3 meses (336 mil)  ~385 ms
--   +6 meses (570 mil)  ~650 ms
--   +12 meses (1,04 mi) ~1.190 ms
--
-- Webhook lento faz uazapi e Meta reenviarem por timeout -> mensagem
-- duplicada. Corrigido ANTES de acontecer.
--
-- O índice trigram torna o ILIKE '%x' indexável sem mexer no app: o planner
-- passa a combinar os dois índices num BitmapOr.
--
--   antes:  117 ms (Seq Scan)
--   depois:  1,5 ms (BitmapOr)
--
-- Custo de escrita medido antes de manter: 200 inserções em 120 ms = 0,6 ms
-- por mensagem, ~2 s por dia no volume atual. Índice ocupa 15 MB.
-- ---------------------------------------------------------------------
create extension if not exists pg_trgm;

create index if not exists idx_messages_external_id_trgm
  on messages using gin (external_id gin_trgm_ops);

analyze conversations;
analyze messages;


-- ---------------------------------------------------------------------
-- ATENÇÃO ao aplicar em base com tráfego: estes CREATE INDEX travam escrita
-- enquanto rodam (o GIN sobre 100 mil linhas é pesado). Em produção foram
-- criados com CREATE INDEX CONCURRENTLY, que não bloqueia mas não pode rodar
-- dentro de transação — por isso aqui ficam na forma simples. Rode fora do
-- horário de pico, ou repita manualmente com CONCURRENTLY.
-- ---------------------------------------------------------------------
