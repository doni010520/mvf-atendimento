# Changelog

Versões do MVF Chat. A versão no ar fica em `GET /api/version` e no topo da tela.
A imagem é publicada com tag de versão (`:vX.Y.Z`) e do commit (`:<sha>`).

## v2.41.16 — retry automático no erro genérico da Meta
- **Incidente Alexandre Morsan → Geovana Nascimento, 04/09:** mensagem falhou
  com `[131000] Something went wrong` (HTTP 500 genérico do lado da Meta, sem
  relação com o número ou o conteúdo) e o balão mostrava só "não foi possível
  entregar a mensagem". O reenvio manual, segundos depois, com o texto
  idêntico, entregou — prova de que era transitório.
- O client da Meta agora tenta de novo sozinho (uma vez, após 1,2s) quando
  recebe 131000, no ponto único que despacha texto/template/mídia — cobre os
  três de uma vez. Se mesmo assim falhar, o balão explica: "erro momentâneo do
  WhatsApp (o sistema já tentou de novo automaticamente) — tente reenviar".

## v2.41.15 — IA não sabia que dia era hoje
- **Incidente protocolo 202609040059, 04/09:** a IA disse "você tem faturas em
  aberto, a mais recente venceu em 05/09/2026" — no dia 04/09, ou seja, um dia
  ANTES do vencimento. A cliente corrigiu ("Hoje ainda é 04") e só na segunda
  tentativa a IA acertou ("faturas a vencer... vencimento em 05/09/2026").
- **Causa:** o prompt informava a IA só do dia da semana e da hora ("sexta-feira,
  10:09") — NUNCA a data completa. Sem saber o dia/mês/ano de hoje, não tem como
  a IA comparar com o vencimento de uma fatura e dizer se já venceu ou não; ela
  estava adivinhando.
- Corrigido: o "Momento atual" do prompt agora leva a data completa
  (dia/mês/ano), e uma regra explícita manda comparar o vencimento com hoje
  antes de dizer "vencida"/"vence hoje"/"a vencer" — nunca mais "venceu" para
  uma data futura.

## v2.41.14 — Quadro de melhorias e falhas
- Nova tela `/melhorias`, mesmo desenho já validado em produção no
  correa-atendimento desde 01/09/26 (mesma família de app — código do
  quadro copiado quase 1:1, só a notificação de grupo foi reduzida ao
  mínimo porque o MVF não tem o transporte de avisos internos do Corrêa).
- Quatro colunas (Novo · Analisando · Resolvendo · Concluído). Qualquer
  pessoa registra falha ou melhoria, com título, descrição opcional e print
  opcional (até 8 MB) — sem trava de permissão, decisão deliberada: time
  pequeno, travar aqui só cria atrito.
- Card recebe um NÚMERO (#1, #2...) assim que criado — é como a equipe vai
  se referir a ele ("resolveu o 14?").
- **Duas formas de mover**: arrastar (desktop) e um seletor de status dentro
  do card. O kanban de conversas usa só `draggable` do HTML5, que não
  funciona em toque — e quem relata problema costuma estar no celular, com
  o print na mão. Copiar sem o seletor entregaria uma tela que metade da
  equipe não consegue operar.
- Card é gravado ANTES do upload do print: se a imagem falhar, o texto do
  relato não se perde. Erro no envio não fecha o formulário, para não
  perder o que a pessoa já escreveu.
- Trava síncrona contra duplo-clique no botão Enviar (useRef, não useState)
  — o `disabled` de um `useState` depende de um re-render, que não é rápido
  o bastante para dois cliques em sequência; já veio assim do Corrêa, onde
  esse exato bug duplicou um relato no primeiro dia de uso.
- Sem comentários, prioridade, responsável, prazo, busca ou exclusão —
  fora de escopo de propósito. Concluído mostra só os últimos 30 dias.
- Aviso de novo card num grupo do WhatsApp é opcional e nasce desligado:
  preencha `feedback_notifier_channel_id` (canal uazapi conectado) e
  `feedback_group_jid` em `organizations.settings` para ligar.
- Testes: 16 casos cobrindo validação, formatação do aviso, agrupamento por
  coluna e o cálculo de "há quanto tempo parado" — trazidos junto com a
  lógica, e o projeto ganhou `vitest` (`npm test`), que ainda não existia.

## v2.41.13 — corrida do atendente x IA em conversa nova
- **Incidente Alexandre Morsan (04/09, protocolo 202609040053):** cliente
  escreveu, Alexandre assumiu dentro dos 8s de debounce, mas a IA respondeu do
  mesmo jeito — e, ao processar o turno, reescreveu o status da conversa de
  volta para "bot", apagando silenciosamente a atribuição. Minutos depois a
  rotina de inatividade viu status "bot" e devolveu a conversa pra fila
  (mensagem de horário comercial no meio do atendimento), obrigando o
  atendente a assumir de novo — as DUAS atribuições vistas na tela.
- **Causa:** a checagem "um humano já assumiu?" tinha uma exceção pra conversa
  nova (`!isNew`) que pulava a verificação justamente na janela onde a corrida
  acontece. Numa conversa nova legítima o status já nasce "bot", então a
  exceção nunca foi necessária — só abria o furo. Removida nos dois pontos de
  recheque (fim do debounce e dentro do lock por conversa).
- **Reforço:** a rotina de inatividade agora também exige `assigned_user_id`
  vazio antes de "resgatar" uma conversa "bot" — mesmo que outro bug deixe
  esse estado inconsistente de novo, ela não atropela quem já está atendendo.

## v2.41.12 — número real da conversa, agora também no uazapi
- **A correção do "número real" de ontem só funcionava na API Oficial.** Ela
  buscava a última mensagem recebida filtrando por `external_id like wamid.%`
  — formato exclusivo da Meta. Nos canais uazapi (FIRMINO ALVES, NOVA CANAÃ,
  RIO DO MEIO, IBICUI 2, IGUAI 2) o formato é `<telefone>:<id>`; a busca nunca
  encontrava nada e a correção nunca chegava a rodar nesses canais.
- **Incidente TATIANE LICITAÇÕES** (protocolo 202609020242, canal Firmino
  Alves): não era o nono dígito — o cadastro tinha DDD e dígitos totalmente
  diferentes do número real dela (provável extração de um identificador
  privado do WhatsApp — @lid — no lugar do telefone, na criação do contato).
  Toda mensagem que ela mandou, sem exceção, veio de um número diferente do
  cadastrado.
- Agora `waRecipient` reconhece os dois formatos e confia em QUALQUER wa_id
  confirmado pela última mensagem recebida NESTA conversa — não só quando bate
  com o DDD do cadastro. A mensagem do cliente já é a prova de qual é o número
  certo.
- Cobre os 9 pontos de envio de uma vez (texto, template, mídia, localização,
  contato, PIX manual, boleto, contrato) e destrava, de saída, todos os canais
  uazapi que a correção anterior nunca alcançou.

## v2.41.11 — "não entregue" agora diz o motivo
- A Meta e o uazapi já mandavam o motivo real da falha (número inexistente,
  janela de 24h, limite de mensagens...), mas o balão sempre mostrava o mesmo
  aviso genérico e a tooltip fixa dizia "geralmente janela fechada" mesmo
  quando não era. O motivo real ficava só em log técnico que a operação não
  acompanha (caso: 26 templates recusados por número sem WhatsApp, 02-03/09,
  todos aparecendo como "não entregue" sem explicação).
- Agora o motivo é traduzido pra português e gravado na mensagem
  (`messages.failure_reason`, migration `0031`) — passar o mouse em "não
  entregue" mostra a razão real. Cobre os 9 pontos de envio: texto, template,
  anexo, localização, contato, PIX manual, boleto e contrato em PDF.
- Sem a migration a coluna não existe: os inserts continuam funcionando
  (mesmo padrão tolerante das correções anteriores), só sem o motivo detalhado.

## v2.41.10 — nono dígito também nos canais uazapi
- **"no LID found for <numero>@s.whatsapp.net"**: o uazapi recusa o envio quando
  o número não existe NA FORMA enviada — o cadastro com o 9 e o WhatsApp do
  cliente sem ele (ou o contrário). Diferente da Meta, que tolera e às vezes
  reclama depois, aqui o erro vem na hora: agora o envio tenta a outra variante
  do mesmo número imediatamente e entrega na mesma ação.
- Vale para texto e mídia, em todos os canais uazapi (FIRMINO ALVES, NOVA CANAÃ,
  RIO DO MEIO, IBICUI 2, IGUAI 2) — inclui os 279 pares duplicados que não
  puderam ser consolidados por falta do identificador da Meta.
- Incidente: TATIANE LICITAÇÕES, protocolo 202609020242, 4 mensagens da atendente
  recusadas em sequência.

## v2.41.9 — correção do próprio conserto do nono dígito
- Quando o contato existia nas DUAS variantes, a v2.41.8 tentava renomear o
  duplicado para um telefone já ocupado: o update batia na chave única
  (organization_id, phone), falhava calado e mesmo assim registrava "cadastro
  corrigido" a cada mensagem (visto 5x seguidas no mesmo contato). A conversa
  ia para o lugar certo, mas o log mentia e o update se repetia.
- Agora só renomeia quando o número certo ainda NÃO existe, confere o erro do
  update e registra o que realmente aconteceu. Par duplicado é resolvido pela
  consolidação, não pelo webhook.

## v2.41.8 — resposta do atendente que não chegava (o nono dígito)
- **Diagnóstico:** a Meta recusava com `131026 Message Undeliverable` e a
  mensagem sumia sem explicação — o bot entregava e a atendente não. O `wamid`
  provou o motivo: o bot responde ao `wa_id` do webhook (ex.: `557134020889`),
  enquanto o atendente usava o telefone do cadastro, que `canonicalPhone()`
  grava SEMPRE com o nono dígito (`5571934020889`). Na região, 93% dos `wa_id`
  vêm SEM o 9; a Meta tolera o 9 a mais quase sempre, e no resto devolve 131026.
- **Envio** passa a usar o `wa_id` confirmado pelo WhatsApp na última mensagem
  recebida (só troca quando é o mesmo número: DDD + 8 dígitos finais iguais).
- **Cadastro** no webhook da API Oficial grava o `wa_id` exato; se já existir
  contato na outra variante, ele é corrigido em vez de duplicado — a base se
  conserta conforme os clientes escrevem.
- **Rede de segurança:** um 131026 dispara reenvio automático na outra variante
  do mesmo número, corrige o cadastro e registra em `app_logs`. Antes só o
  131047 (janela de 24h) tinha tratamento.
- `canonicalPhone()` segue igual para número digitado/colado do SGP — ali o 9 é
  o certo e é o que evita contato duplicado.

## v2.41.7 — IA não pergunta mais "Como posso ajudar?"
- Depois de validar o CPF/CNPJ, o prompt mandava responder "Um momento por favor"
  e **"Como posso ajudar?"** — pergunta genérica que costumava repetir algo que o
  cliente já tinha dito. Agora a IA emenda direto no assunto; só pergunta quando o
  cliente realmente não disse o que quer, e de forma específica.

## v2.41.6 — hotfix: envio de arquivo pelo atendente voltou a funcionar
- **Regressão da v2.41.5.** A proteção contra a coluna `media_name` inexistente
  (migration `0030` ainda não aplicada) foi parar na função de TEXTO por engano;
  o insert da MÍDIA ficou desprotegido. Resultado entre 13h37 e 18h: o arquivo
  ia para o cliente (o envio acontece antes), mas a mensagem não era gravada, o
  atendente via "Falha no envio do arquivo" e reenviava — cliente recebendo o
  mesmo arquivo 2–3 vezes e nada no histórico.
- A proteção agora está no insert certo, e a falha de insert devolve erro
  específico e vai para `app_logs` em vez de estourar num alerta genérico.

## v2.41.5 — arquivo do cliente baixa com a extensão certa (fim do ".bin")
- **Documento do cliente virava `.bin`.** O mapa de mimetypes conhecia só 12 tipos
  (imagem/áudio/vídeo/PDF); planilha, Word, zip e afins caíam no fallback e iam
  para o bucket como `<id>.bin` — o atendente baixava e o Excel recusava abrir.
  Agora a extensão é decidida por: mimetype conhecido → nome original do arquivo →
  **assinatura dos bytes** (`%PDF`, `PK`, OLE2, JPEG, PNG…) → extensão da
  URL. A assinatura resolve o caso mais comum, que é a UAZAPI mandar
  `application/octet-stream` sem dizer o que é.
- **O nome que o cliente mandou parou de ser jogado fora.** O webhook (UAZAPI e
  Meta) traz `fileName`; ele é guardado em `messages.media_name` e aparece no balão
  no lugar de "Abrir documento".
- **O download passou a respeitar o nome.** O bucket fica em outro domínio, então o
  atributo `download` do `<a>` é ignorado pelo navegador — o arquivo caía no disco
  com o nome do storage. O link agora usa `?download=<nome>` do Supabase Storage,
  que manda o `Content-Disposition` certo.
- Os inserts de mensagem toleram a ausência de `media_name` (migration `0030`):
  sem isso, subir o código antes da migration derrubaria a gravação de TODAS as
  mensagens recebidas. Enquanto a migration não roda, a extensão já vem correta e
  só o nome fica sendo o id do storage.

## v2.41.1 — editar/apagar mensagem que não mente
- **O resultado passou a valer.** `editMessageAction` engolia o erro do provedor e
  atualizava o banco assim mesmo: o atendente via a mensagem editada enquanto o
  cliente continuava lendo o texto velho. Agora o texto local só muda se o
  WhatsApp do cliente aceitar, e a falha aparece na tela com o motivo.
  Idem para "apagar para todos" — só marca como apagada se revogou de verdade.
- **Prazo do WhatsApp:** edição é recusada com aviso claro depois de 15 minutos,
  em vez de erro genérico do provedor.
- **"Apagar para todos" some em mensagem recebida:** não existe apagar do aparelho
  do outro — o botão prometia o impossível e falhava sempre.
- **Apagar volta a aparecer nas linhas da API Oficial**, só que como "apagar aqui":
  tira a mensagem da conversa da equipe (fica no histórico para auditoria) e diz,
  com todas as letras, que o cliente continua vendo. 7 em cada 10 conversas estão
  nas linhas oficiais — era ali que a opção fazia falta.
- Falhas de edição/revogação passam a ser registradas em `app_logs` (antes só
  `console.error`, invisível).

## v2.41.0 — PWA de verdade
- **Notificações push:** o atendente é avisado com o app fechado. Conversa com dono
  avisa só o dono; conversa na fila avisa quem tem `notify` ligado; conversa com o
  bot não avisa ninguém. Menção interna (`@atendente`) também vira push.
  Ligar em *Ajustes* ou *Meu perfil* → “Notificações neste aparelho” (é por aparelho).
- **Service worker** (`public/sw.js`) mínimo por decisão: cacheia só arquivo com hash
  (`/_next/static/*`, `/icons/*`) e recebe o push. Não toca em HTML, RSC, `/api/*`
  nem POST — HTML cacheado reproduziria o “Failed to find Server Action”, preso no
  aparelho. Escape hatch por dispositivo: abrir o app com `?nosw=1`.
- **Ícones e manifest corretos:** 192/512/maskable + apple-touch-icon (antes um único
  PNG de 150px era declarado como 192 e 512); manifest com `id`, `scope`, atalhos.
- **`theme-color` volta a existir:** estava dentro do `metadata`, que o Next 16 ignora
  em silêncio; movido para o `export const viewport`.
- Chaves VAPID geradas e guardadas sozinhas (`organizations.settings.push_vapid`) —
  ligar o push não depende de env var no Easypanel. Migration `0027` cria a tabela
  `push_subscriptions`; até rodar, as inscrições ficam no fallback jsonb.

## v2.22.0
- Apagar mensagem deixa de aparecer em conversas do canal **Meta (API Oficial)**,
  já que a Meta não permite revogar mensagem enviada. UAZAPI mantém as duas opções.

## v2.21.0
- Limpeza da sidebar: remove "Chaves de API" (sem API consumindo) e tira
  "Auditoria" e "Exportar contatos" do menu (export já é botão em Clientes).
  "Integrações" vira **SGP** e passa para a seção Empresa.

## v2.20.0
- Deploys identificáveis: imagem ganha tag de **versão** (`:vX.Y.Z`) além do SHA;
  `/api/version` agora também expõe o **commit** (via `GIT_SHA` no build).
- Este CHANGELOG.

## v2.19.0
- Modal de apagar mensagem com **as duas opções sempre** (para mim / para todos),
  sem texto explicativo. README com a seção "Funcionalidades do chat".

## v2.18.0
- **Apagar mensagem** com modal próprio (para mim / para todos) e **auditoria**:
  a mensagem fica esmaecida e visível para a equipe (não some do banco).

## v2.17.0
- **Encerramento por inatividade** (avisa → despede → fecha → reinicia o fluxo) e
  **ao resolver** (IA `finalizar_atendimento` fecha a conversa). Configurável em
  Ajustes → Configurações → Atendimento. Cron via `/api/cron` (`CRON_SECRET`).

## v2.16.0
- Correção do SGP: painel deixa de usar o CPF `00000000000` (que travava o SGP);
  cliente SGP com timeout (AbortController).

## v2.15.0
- Endpoint público **`/api/version`** + `deploy.mjs` robusto (confirma a versão no ar).

## v2.14.0
- **Logs no banco** (`app_logs`) visíveis no `/superadmin`; tela do agente de IA
  mostra/edita o prompt-base.

## v2.13.0
- **Mensagens internas** entre atendentes (chat interno + `@menção` + sino em tempo real).

## v2.12.0
- **Buffer/debounce** de mensagens do bot (rajadas viram 1 resposta). `BOT_DEBOUNCE_MS`.
