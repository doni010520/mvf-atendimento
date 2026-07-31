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
- **Áudio:** grava pelo microfone no próprio composer. Durante a gravação há **cancelar (descarta sem enviar)** e **enviar** — nunca envia sem confirmar. No canal oficial (Meta), o áudio `webm` do navegador é **convertido para `ogg/opus`** (ffmpeg) antes de sair, já que a Meta não aceita `webm`.
- **Imagem/mídia recebida:** visualizador (lightbox) com zoom/scroll, **abrir original** em nova aba e **baixar**.

### Sobre as mensagens
- **Ações:** responder/citar, reagir (emoji), editar, **apagar (para mim / para todos)** e encaminhar.
  - Apagada fica **esmaecida** e visível para a equipe (auditoria); “para todos” revoga no cliente quando o canal suporta (UAZAPI).
- **Menções:** de contatos em grupos (`@contato`) e de atendentes (`@atendente`).
- **Tempo real:** mensagens, status (entregue/lido/reação) e menções via Supabase Realtime.

### PIX / mensagens interativas
- **Cartão de PIX com botão “Copiar código”** — o cliente toca e copia o código copia-e-cola inteiro, sem selecionar texto na mão.
  - **UAZAPI:** botão de cópia via `/send/menu` (`copy:`).
  - **Meta oficial:** cartão **Offsite Pix** (`order_details`) com valor, comerciante e chave.
- **No MVF Chat** a própria bolha detecta o código PIX (EMV `000201…`) e o exibe como um **cartão “PIX copia e cola” com botão Copiar** — o atendente tem a mesma leitura do cliente, em vez de um código “embolado”. Vale para mensagens novas **e antigas** (é só renderização).
- O **agente de IA** detecta um código PIX (SGP 2ª via) e já envia nesse formato de cartão automaticamente; se o canal não suportar, cai para texto com o código.

### Atendimento
- **Ações:** assumir, transferir (departamento), encerrar (com CSAT), silenciar.
- **Protocolo:** ao **assumir**, gera e registra um **número de protocolo** e dispara a mensagem de boas-vindas para o cliente. Atendimentos podem ser **buscados pelo número de protocolo**.
- **Mensagens internas entre atendentes** (aba no composer) + **notificações de menção** (sino, tempo real).
- **Notas internas** na conversa.
- **Respostas rápidas / macros** e **templates** (Meta, fora da janela de 24h).

### Integração SGP (no painel do contato)
- **Busca por CPF/CNPJ** varre **todos os SGPs** configurados (multi-SGP) e lista **todos os contratos** do cliente; quando há mais de um, mostra um **seletor de contrato**.
- Consulta de cliente, faturas, **2ª via / PIX**, liberação em confiança e chamados — tanto pelo atendente quanto como ferramentas do agente de IA.

### IA e automação
- Pausar/reativar o agente por conversa; **buffer de rajada** (junta mensagens seguidas e responde 1x); encerra ao **resolver** ou por **inatividade** (com aviso e despedida) e reinicia o fluxo.
- **Grupos:** participantes, “responder no privado”.
- Painel de contato: dados, tags e campos personalizados.

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

## Webhooks (precisam de URL pública)

- UAZAPI: `POST  https://mvfchat.benitechlab.com/api/webhooks/uazapi`
- Meta:   `GET/POST https://mvfchat.benitechlab.com/api/webhooks/meta`
  (GET valida `META_VERIFY_TOKEN`; POST valida `X-Hub-Signature-256` com `META_APP_SECRET`)

## Cron / agendador

`GET /api/cron?secret=<CRON_SECRET>` executa, por organização:
- **encerramento por inatividade** (avisa, despede e fecha; reinicia o fluxo no próximo contato);
- **auto-transferência** por tempo sem interação.

Precisa de um agendador externo chamando a URL a cada poucos minutos (ex.: cron-job.org,
ou um container `alpine` com `wget` em loop no próprio Easypanel). Tempos e mensagens são
configuráveis em **Ajustes → Configurações → Atendimento**.

## Deploy (produção)

Build na nuvem, deploy do artefato (VPS só baixa a imagem):

1. `git push origin master` → **GitHub Actions** builda e publica
   `ghcr.io/doni010520/mvf-atendimento:<SHA-completo>` (+ `latest`).
2. No **Easypanel** (projeto `liriel`, serviço `mvf-app`), o Source é **Docker Image**
   fixado pelo **SHA**. Aponte a tag para o novo SHA e faça **Deploy**
   (ou rode `_scraper/deploy.mjs <sha>` com `EP_TOKEN` + `GH_TOKEN`).
3. Confirme com `GET /api/version` (deve refletir o `APP_VERSION` de `src/lib/version.ts`).

Sempre incremente `APP_VERSION` a cada release.

## Estrutura

```
src/app/(app)/*       telas autenticadas (atendimento, dashboard, canais, automações,
                      relatórios, ajustes, superadmin, ...)
src/app/login         login / cadastro / onboarding
src/app/api/cron      encerramento por inatividade + auto-transferência (CRON_SECRET)
src/app/api/version   versão pública no ar (diagnóstico de deploy)
src/app/api/webhooks  rotas de webhook (uazapi, meta)
src/components/inbox  caixa de entrada (lista, thread, composer, mensagens internas)
src/lib/supabase      clientes (browser/server) + middleware de sessão (proxy.ts)
src/lib/whatsapp      adapters ChannelProvider (uazapi.ts, meta.ts), inbound, chatbot, ai
src/lib/sgp           cliente da API URA do SGP
src/lib/log.ts        logEvent → app_logs (visível em /superadmin)
supabase/migrations   schema + RLS + realtime
```

Plano de arquitetura: `../PLANO.md`.
