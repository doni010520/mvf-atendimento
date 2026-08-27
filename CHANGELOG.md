# Changelog

Versões do MVF Chat. A versão no ar fica em `GET /api/version` e no topo da tela.
A imagem é publicada com tag de versão (`:vX.Y.Z`) e do commit (`:<sha>`).

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
