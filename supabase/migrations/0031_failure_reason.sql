-- Motivo da falha de entrega, em português, para exibir ao atendente.
-- Sem isso o balão só dizia "não entregue" sem explicar por quê (número
-- inexistente, janela de 24h fechada etc.) — o motivo real ficava só em
-- app_logs, que a operação não acompanha.
alter table messages add column if not exists failure_reason text;
