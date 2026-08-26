-- =====================================================================
-- 0028 — Correções aplicadas no incidente de 26/08/2026
--
-- Contexto: o Realtime parou de entregar QUALQUER evento (4.191 erros em 24h,
-- ~100% de falha). O front caía no fallback de router.refresh(), que reconsulta
-- conversation_overview a cada erro + a cada 8s; a view estourava o
-- statement_timeout de 8s do papel `authenticated` e o RSC falhava — a "tela
-- branca" e as "5 atribuições" que os atendentes relataram.
--
-- Este arquivo registra o que foi corrigido direto no banco, para que um
-- ambiente novo (ou uma reaplicação das migrations) não recrie o problema.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) CAUSA RAIZ DO REALTIME: EXECUTE em current_org_id() para `anon`.
--
-- O Realtime (WALRUS) avalia as policies de RLS a cada mudança no WAL para
-- decidir quem recebe cada linha. As policies de messages/conversations chamam
-- current_org_id(). Alguém havia revogado o EXECUTE de PUBLIC/anon nessa
-- função — provavelmente tentando silenciar um aviso de segurança do painel.
--
-- Toda assinatura criada com claims_role='anon' (aba que assina antes do JWT
-- ser anexado ao socket, ou com token expirado) passava a estourar:
--
--   PoolingReplicationError: permission denied for function current_org_id
--     em realtime.apply_rls(jsonb,integer) -> execute walrus_rls_stmt
--
-- O erro NÃO fica isolado na assinatura ruim: ele derruba a chamada
-- realtime.list_changes() inteira. Uma única aba `anon` cegava todos os
-- atendentes simultaneamente.
--
-- Devolver o EXECUTE não expõe dado nenhum: para o anon, auth.uid() é NULL,
-- a função retorna NULL, a policy vira `organization_id = NULL` -> NULL ->
-- falso, e nenhuma linha é entregue. É o default do próprio Supabase.
-- ---------------------------------------------------------------------
grant execute on function public.current_org_id() to anon;
grant execute on function public.current_role_is(text) to anon;


-- ---------------------------------------------------------------------
-- 2) ÍNDICE FALTANTE (metade da 0025_perf_indexes nunca foi aplicada).
--
-- idx_messages_unread existia; idx_messages_last_noninternal não. Sem ele, o
-- lateral join da "última mensagem não-interna" em conversation_overview varria
-- messages por conversa. Com 101k mensagens / 8.4k conversas isso estourava os
-- 8s de statement_timeout. Depois do índice: 99ms para as 50 primeiras.
-- ---------------------------------------------------------------------
create index if not exists idx_messages_last_noninternal
  on messages (conversation_id, created_at desc)
  where coalesce(is_internal, false) = false;

analyze messages;


-- ---------------------------------------------------------------------
-- 3) protocol_counters estava totalmente aberta.
--
-- A tabela tinha RLS DESLIGADA e `anon` com SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE. Como a anon key é pública (vai no bundle do navegador e está no
-- deploy.yml), qualquer pessoa na internet podia zerar ou truncar os contadores
-- de protocolo pela REST — quebrando a numeração de todas as organizações.
--
-- CUIDADO ao mexer: assign_protocol() NÃO era SECURITY DEFINER, então rodava
-- com o papel de quem inserisse a conversa. E conversas SÃO inseridas como
-- `authenticated` pela UI (openConversation em atendimento/actions.ts e as
-- campanhas), não só pelo service role dos webhooks. Ligar a RLS sem antes
-- dar autonomia ao trigger quebraria o botão de abrir conversa.
--
-- Por isso a ordem abaixo importa: primeiro o trigger passa a rodar como dono,
-- só depois a porta é fechada.
--
-- O `set search_path` não é decoração: uma função SECURITY DEFINER sem
-- search_path fixo fica vulnerável a sequestro de search_path.
-- ---------------------------------------------------------------------
alter function public.assign_protocol() security definer;
alter function public.assign_protocol() set search_path = public, pg_temp;

alter table public.protocol_counters enable row level security;
-- Sem policies: ninguém acessa direto. O trigger (SECURITY DEFINER, dono
-- postgres) e o service role continuam funcionando.
revoke all on table public.protocol_counters from anon;
revoke all on table public.protocol_counters from authenticated;
revoke all on table public.protocol_counters from public;
