# MVF Chat — clone do Chatmix

SaaS multi-tenant de **multiatendimento e automação via WhatsApp** para ISPs.
Inclui caixa de entrada em tempo real, **agente de IA** (OpenAI) com ferramentas do
**SGP** (consulta de cliente, faturas, 2ª via/PIX, liberação, chamados), construtor
de fluxos estilo ManyChat, mensagens internas entre atendentes, relatórios e painel
de superadmin.

Stack: **Next.js 16 (App Router, standalone) + TypeScript + Tailwind v4 + Supabase (Cloud)**.
Canais WhatsApp: **UAZAPI** (não oficial, QR) e **Meta Cloud API** (oficial).

Produção: **https://mvfchat.benitechlab.com** · versão atual em `GET /api/version`.

## Funcionalidades do chat (WhatsApp)

### Envio de mensagens
- **Tipos:** texto, imagem, vídeo, documento (com legenda), figurinha, **áudio gravado**, localização e contato.
- **Áudio (gravação):** grava pelo microfone no próprio composer, com **cronômetro (mm:ss)** e **medidor de nível do microfone** (se as barrinhas não mexem, o mic não está captando). Durante a gravação a barra ocupa a **linha inteira**: 🗑️ **cancelar** (descarta sem enviar) | tempo + medidor | ➤ **enviar** — nunca envia sem confirmar. Gravação **muda é bloqueada** com orientação (evita mandar áudio que o cliente não consegue tocar). O recorder usa *timeslice* + `requestData()` para nunca gerar arquivo truncado.
- **Áudio (formato):** todo áudio para canal **Meta** é convertido para **MP3** (ffmpeg, mono 64k) — inclusive a voz do bot (TTS). Motivo aprendido em produção: o WhatsApp do iPhone recusava `ogg/opus` (“este áudio não está mais disponível”) mesmo com arquivo íntegro e `delivered`; o mesmo áudio em MP3 toca. A conversão acontece no ponto único de saída para a Meta.
- **Vídeo:** o limite de upload do app é **64MB** (`serverActions.bodySizeLimit` — o padrão de 1MB do Next.js bloqueava QUALQUER vídeo com “server error”). Vídeo **>16MB** em canal Meta é avisado antes do envio (teto de vídeo da Cloud API).
- **Mídia na Meta por ID:** toda mídia enviada aos números oficiais é **subida para a Meta (`/media`) e enviada por `id`** — enviar por link fazia a mídia “expirar” no cliente.
- **Imagem/mídia recebida:** visualizador (lightbox) com zoom/scroll, **abrir original** em nova aba e **baixar**.

### Sobre as mensagens
- **Ações:** responder/citar, reagir (emoji), editar, **apagar (para mim / para todos)** e encaminhar.
  - Apagada fica **esmaecida** e visível para a equipe (auditoria); “para todos” revoga no cliente quando o canal suporta (UAZAPI).
- **Menções:** de contatos em grupos (`@contato`) e de atendentes (`@atendente`).
- **Tempo real:** mensagens, status e menções via Supabase Realtime.
- **Status de entrega Meta de verdade:** o webhook processa `statuses[]` — ✓ **entregue**, ✓✓ **lido** e **falhas com o motivo da Meta** (código + descrição, ex.: `131047` fora da janela de 24h) registradas em `app_logs`. Sem isso, tudo ficava “sent” para sempre e a causa das falhas se perdia.
- **Apagar/editar na API oficial NÃO existe** (confirmado na doc da Meta): nos números oficiais, mensagem enviada é definitiva no cliente — o “apagar” só marca no histórico interno. No UAZAPI o “apagar para todos” revoga de verdade.

### PIX / mensagens interativas
- **Cartão de PIX com botão “Copiar código”** — o cliente toca e copia o código copia-e-cola inteiro, sem selecionar texto na mão.
  - **UAZAPI:** botão de cópia via `/send/menu` (`copy:`).
  - **Meta oficial:** cartão **Offsite Pix** (`order_details`) com valor, comerciante e chave.
- **No MVF Chat** a própria bolha detecta o código PIX (EMV `000201…`) e o exibe como um **cartão “PIX copia e cola” com botão Copiar** — o atendente tem a mesma leitura do cliente, em vez de um código “embolado”. Vale para mensagens novas **e antigas** (é só renderização).
- O **agente de IA** detecta um código PIX (SGP 2ª via) e já envia nesse formato de cartão automaticamente; se o canal não suportar, cai para texto com o código.

### Atendimento
- **Ações:** assumir, transferir, encerrar (com CSAT), silenciar. Toda **transferência deixa um marcador visível** no histórico (“🔄 Fulano transferiu para Beltrano”).
- **Transferir** tem 3 modos: **Pessoa** (vira dona), **Vários** (oferece a colegas selecionados — **o primeiro que assumir/responder fica** e a conversa some dos outros; coluna `offered_to`) e **Departamento** (volta pra fila).
- **Protocolo:** ao **assumir**, gera e registra um **número de protocolo** e dispara a mensagem de boas-vindas para o cliente. Atendimentos podem ser **buscados pelo número de protocolo**.
- **Visibilidade por atendente:** um **atendente** (não-admin) vê só as conversas **sem dono** (fila/IA, ou oferecidas a ele) + as **atribuídas a ele**; nunca as de outro atendente. **Admin/dono veem tudo.** Quem **responde assume** a conversa automaticamente se ela ainda não tiver dono. O filtro roda **no SQL antes de qualquer limite** — conversas ativas nunca são cortadas da lista.
- **Modal de atendimento (V2/Kanban) sem fechamentos acidentais:** clique no fundo só fecha se começou E terminou no fundo (selecionar texto não fecha); ESC não fecha o atendimento com sub-modal aberto (encerrar/transferir/nota).
- **Mensagens internas entre atendentes** (aba no composer) + **notificações de menção** (sino, tempo real).
- **Notas internas** na conversa.
- **Respostas rápidas / macros** e **templates** (Meta, fora da janela de 24h). Templates são **por número/WABA** — o composer mostra só os do canal daquela conversa (picker com rolagem e nomes truncados); sincronize em *Mensagens → Templates* (varre todos os números Meta). O envio exige preencher as variáveis: a **`{{1}}` já vem pré-preenchida com o primeiro nome do cliente** nos modelos de saudação, e uma **dica visível** avisa quando falta preencher (o botão fica desabilitado até lá — era lido como "modelo indisponível").
- **Histórico completo do cliente no thread:** cada atendimento é uma conversa nova internamente, mas ao abrir qualquer conversa o chat carrega **todas as mensagens do contato naquele número** mescladas em ordem (últimas 600) — rola pra cima e vê o passado, estilo WhatsApp. O painel direito lista os **Atendimentos anteriores** (protocolo + resumo do encerramento + alerta de pendência) e o **"Ver conversa"** abre qualquer atendimento antigo mesmo que ele não apareça na lista do atendente (acesso legítimo ao histórico de um cliente que ele atende).

### Integração SGP (no painel do contato)
- **Busca por CPF/CNPJ** varre **todos os SGPs** configurados (multi-SGP) e lista **todos os contratos** do cliente; quando há mais de um, mostra um **seletor de contrato**.
- **Ações SGP na conversa:**
  - 🧾 **2ª Via** — baixa o **boleto em PDF** no SGP e envia como documento (fallback: linha digitável + link em texto);
  - 📄 **Contrato** — baixa o **PDF do contrato** (`/api/contratos/print/contrato`; o endpoint exige GET com params no corpo — tratado via `node:https`) e envia como documento;
  - 💠 **PIX** — envia a fatura mais antiga em aberto como cartão com botão Copiar;
  - 🔓 **Liberar** (confiança) e 🛠️ **Status** da conexão.
- Consulta de cliente, faturas, 2ª via/PIX, liberação e chamados também como **ferramentas do agente de IA**.
- **Gateway “SMS” do SGP → WhatsApp** (`/api/sgp/sms`): substitui o HTTP Genérico do Chatmix. O SGP dispara os avisos (vencimento, cobrança, link de contrato…) para este endpoint (`numero` + `mensagem` + `token` = `SGP_SMS_TOKEN`) e o app entrega pelo WhatsApp, registrado na conversa + `app_logs`. Detalhes importantes:
  - **Linha de saída configurável:** `SGP_SMS_CHANNEL` no ambiente (ou `canal=` na requisição) define o canal padrão — em produção normal é **MVF CENTRAL**; em modo teste pode apontar pra uma linha uazapi.
  - **Janela de 24h é tratada de forma ASSÍNCRONA:** a Meta **aceita** o envio (200 + id) e só reporta o `131047` depois, via webhook de statuses. Quando isso acontece com um aviso de sistema, o app reenvia sozinho **como template aprovado pela própria linha oficial**, escolhendo o template **pelo conteúdo**: link de contrato → `envio_de_contrato` ({{1}} = link); demais avisos → `aviso de vencimento` ({{1}} = nome). (São os templates HSM que o Chatmix deixou aprovados.) Existe ainda um template genérico `aviso_mvf_sgp` (carrega o texto exato do SGP) que assume o 1º lugar quando a Meta aprovar. Último recurso: reenvio por canal uazapi (dedup de 10 min).
  - **9º dígito:** o gateway reaproveita o contato existente com/sem o `9` (o wa_id costuma vir sem) — não cria contato duplicado.

### IA e automação
- Pausar/reativar o agente por conversa; **buffer de rajada** (junta mensagens seguidas e responde 1x); encerra ao **resolver** ou por **inatividade** (com aviso e despedida) e reinicia o fluxo.
- **Comprovante de pagamento com conferência DETERMINÍSTICA:** a IA lê o comprovante (visão), mas quem confere o valor é o **código** — busca a fatura mais antiga em aberto no SGP e aplica a regra *pago ≥ fatura CONFERE* (pagar a mais por multa/juros é normal). O veredito sobrescreve o da IA e instrui a liberação por confiança. (Corrige caso real: pagou R$ 61,30 numa fatura de R$ 60,00 + R$ 1,30 de multa e a IA tinha marcado “não bate”.)
- **Grupos:** participantes, “responder no privado”.
- Painel de contato: dados, tags e campos personalizados.

### Mobile / PWA
- O fluxo de atendimento é **responsivo** (padrão WhatsApp mobile): no celular a lista e a conversa alternam em tela cheia, com botão voltar; painel do contato vira overlay.
- **Instalável como app** (PWA, `manifest.json` com `display: standalone`): Android (Chrome → “Adicionar à tela inicial”) e iPhone (**Safari** → Compartilhar → “Adicionar à Tela de Início”). Abre em tela cheia, direto no atendimento.

### Confiabilidade e performance
- **Atualização automática de versão:** após um deploy, quem está com a página aberta vê o aviso “Nova versão disponível” e, se ficar **ocioso** (sem digitar/sem gravar por ~1 min), a página **se atualiza sozinha** — ninguém fica em bundle antigo quebrando Server Actions. Nunca recarrega no meio de uma gravação (`setAppBusy`). O detector exige a **mesma versão nova 2× seguidas** (imune a dois containers no ar).
- **Polling econômico:** lista de conversas a cada 10s e mensagens da conversa aberta a cada 8s, **pausando com a aba oculta** (o realtime cobre o tempo real). Evita esgotar o Disk IO do banco.
- **Índices críticos** (migration `0025`): índices parciais para “não-lidas” e “última mensagem” — a view `conversation_overview` faz 2 lateral joins por conversa e sem índice a listagem travava o banco inteiro (incidente real: timeout total com ~900 conversas).
- **Consultas divididas com teto:** ativas (bot/fila/abertas) até **500** recentes, encerradas até **150** — subir esses números sem necessidade reabre o gargalo de Disk IO do incidente acima (aconteceu de novo em 03/08, corrigido de vez em 18/08).
- **Supabase Pro** com compute dimensionado (o free/nano esgotava o Disk IO Budget e derrubava tudo).
- **Telefone sempre normalizado antes de gravar contato** (`canonicalPhone` em `lib/utils.ts`): adiciona o `55` quando falta (número colado do SGP, sem código do país) e o 9º dígito quando falta. Sem isso, o mesmo cliente virava 2 contatos/conversas conforme a origem do número (webhook, atendente digitando, coexistência Meta, gateway SGP) — resposta do cliente caía numa conversa nova em vez da que o atendente estava vendo.
- **Aviso quando o número não existe no WhatsApp:** antes, um envio pra número inválido só mostrava "não entregue" genérico e o atendente ficava reenviando à toa. Agora o erro da UAZAPI é inspecionado e, se for "not on whatsapp", a mensagem é clara: confirme o número antes de tentar de novo.

## Rodar em desenvolvimento

```bash
cd web
npm install
npm run dev        # http://localhost:3000
```

Sem `.env.local`, o app sobe em **modo preview** (dados de exemplo, sem login).

## Variáveis de ambiente (`.env.local`)

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# App
APP_BASE_URL=https://mvfchat.benitechlab.com   # usado em links e no webhook da Meta

# UAZAPI (canal não oficial)
UAZAPI_HOST=
UAZAPI_ADMIN_TOKEN=
UAZAPI_WEBHOOK_TOKEN=        # valida o webhook da UAZAPI

# Meta Cloud API (canal oficial) — credenciais por canal ficam no banco (channels.credentials);
# estas servem de fallback/global e para o Embedded Signup
META_APP_ID=
META_APP_SECRET=             # valida a assinatura X-Hub-Signature-256 do webhook
META_VERIFY_TOKEN=           # verificação GET do webhook
META_GRAPH_VERSION=v23.0
META_ACCESS_TOKEN=           # opcional (fallback)
META_WABA_ID=                # opcional (fallback)
NEXT_PUBLIC_META_APP_ID=     # Embedded Signup (multi-tenant, futuro)
NEXT_PUBLIC_META_CONFIG_ID=
NEXT_PUBLIC_META_GRAPH_VERSION=v23.0

# IA
OPENAI_API_KEY=              # sem ela o agente de IA não responde

# SGP
SGP_ENCRYPTION_KEY=          # AES-GCM para as credenciais do SGP em integrations.config
SGP_SMS_TOKEN=               # autentica o gateway /api/sgp/sms (mesmo token vai na config do SGP)
SGP_SMS_CHANNEL=             # canal padrão de saída do gateway (ex.: "MVF CENTRAL"; teste: "RIO DO MEIO")

# Bot / automação
BOT_DEBOUNCE_MS=8000         # buffer de rajada: junta mensagens seguidas e responde 1x (0 desliga)

# Cron (encerramento por inatividade, auto-transferência)
CRON_SECRET=                 # protege GET /api/cron?secret=...
```

> Em produção essas variáveis ficam no **Easypanel** (serviço `mvf-app` → Environment),
> não no `.env.local`.

## Banco de dados (migrations)

Schema, RLS e realtime ficam em `supabase/migrations/` (ordem por nome).
As migrations são aplicadas no projeto **Supabase Cloud** (`xzhzbefkxfgvwfqztqan`).

> ⚠️ Algumas migrations recentes foram aplicadas direto no Cloud (via MCP/SQL). Ao
> mexer no schema, **sempre adicione o `.sql` correspondente nesta pasta** para o repo
> reproduzir o banco. Para sincronizar a partir do Cloud: `supabase db pull`.

## Webhooks e endpoints públicos

- UAZAPI: `POST  https://mvfchat.benitechlab.com/api/webhooks/uazapi`
- Meta:   `GET/POST https://mvfchat.benitechlab.com/api/webhooks/meta`
  (GET valida `META_VERIFY_TOKEN`; POST valida `X-Hub-Signature-256` com `META_APP_SECRET`).
  Processa mensagens recebidas, ecos de coexistência **e `statuses[]`** (entregue/lido/falha com motivo).
- Gateway SGP: `GET/POST https://mvfchat.benitechlab.com/api/sgp/sms?token=…&numero=…&mensagem=…`
  — recebe os disparos de aviso do SGP (config HTTP Genérico: `set_to=numero`, `set_msg=mensagem`,
  `token=SGP_SMS_TOKEN`) e entrega via WhatsApp (MVF CENTRAL, fallback uazapi).
  As rotas `/api/webhooks`, `/api/version`, `/api/sgp` e `/api/cron` ficam **fora** do middleware de sessão.

## Cron / agendador

`GET /api/cron?secret=<CRON_SECRET>` executa, por organização:
- **encerramento por inatividade** (avisa, despede e fecha; reinicia o fluxo no próximo contato);
- **auto-transferência** por tempo sem interação.

Precisa de um agendador externo chamando a URL a cada poucos minutos (ex.: cron-job.org,
ou um container `alpine` com `wget` em loop no próprio Easypanel). Tempos e mensagens são
configuráveis em **Ajustes → Configurações → Atendimento**.

## Deploy (produção)

Build na nuvem, deploy do artefato (VPS só baixa a imagem):

1. Incremente `APP_VERSION` em `src/lib/version.ts` e faça `git push origin master`
   → **GitHub Actions** builda e publica `ghcr.io/doni010520/mvf-atendimento:vX.Y.Z`.
2. No **Easypanel** (projeto `liriel`, serviço `mvf-app`): aponte o Source (Docker Image)
   para a nova tag e faça o restart **LIMPO**: **Stop → aguardar cair (503) → Start**.
   > ⚠️ **Não** usar só “Deploy”/rolling: o zero-downtime já deixou **dois containers de
   > versões diferentes** servindo juntos — cada request caía num, quebrando Server Actions
   > (“Failed to find Server Action”, páginas com erro, modal fechando sozinho).
3. Confirme com **várias** chamadas a `GET /api/version` (~15×): **todas** devem retornar
   a MESMA versão nova.
4. Quem estiver com a página aberta é atualizado sozinho (VersionWatcher) ao ficar ocioso.

O deploy reinicia o container (~30–60s fora do ar) — prefira horários calmos.

## Estrutura

```
src/app/(app)/*       telas autenticadas (atendimento, dashboard, canais, automações,
                      relatórios, ajustes, superadmin, ...)
src/app/login         login / cadastro / onboarding
src/app/api/cron      encerramento por inatividade + auto-transferência (CRON_SECRET)
src/app/api/version   versão pública no ar (diagnóstico de deploy)
src/app/api/webhooks  rotas de webhook (uazapi, meta — inclui statuses de entrega)
src/app/api/sgp/sms   gateway de avisos do SGP → WhatsApp (substitui o Chatmix)
src/components/inbox  caixa de entrada (lista, thread, composer, mensagens internas)
src/lib/supabase      clientes (browser/server) + middleware de sessão (proxy.ts)
src/lib/whatsapp      adapters ChannelProvider (uazapi.ts, meta.ts), inbound, chatbot, ai
src/lib/sgp           cliente da API URA do SGP
src/lib/log.ts        logEvent → app_logs (visível em /superadmin)
supabase/migrations   schema + RLS + realtime
```

Plano de arquitetura: `../PLANO.md`.
