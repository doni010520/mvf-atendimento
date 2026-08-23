/*
 * MVF Chat — service worker CONSERVADOR.
 *
 * Regra de ouro deste arquivo: ele NUNCA pode servir HTML velho. O histórico do
 * app já teve dois containers de versões diferentes no ar ao mesmo tempo e o
 * resultado foi "Failed to find Server Action", modal fechando sozinho e páginas
 * quebradas. Um service worker que cacheia documento/RSC reproduz esse mesmo
 * bug — só que preso no aparelho do atendente, sem F5 que resolva.
 *
 * Por isso ele só intercepta o que é IMUTÁVEL (arquivo com hash no nome) e
 * deixa TODO o resto passar direto pela rede:
 *   - POST (Server Action, upload de mídia) ......... não intercepta
 *   - navegação / documento HTML ................... não intercepta
 *   - /api/* e payload RSC (?_rsc=) ................ não intercepta
 *   - outra origem (Supabase, Meta, uazapi) ........ não intercepta
 *
 * O que ele faz de útil: guarda os bundles/ícones (app abre instantâneo na
 * segunda vez) e recebe as notificações push quando o app está fechado.
 */

const SW_VERSION = "1";
const STATIC_CACHE = `mvf-static-v${SW_VERSION}`;

self.addEventListener("install", () => {
  // Sem precache: nada de baixar lista de arquivos na instalação. O cache é
  // preenchido sob demanda, com o que o app realmente pediu.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("mvf-") && k !== STATIC_CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Só arquivo com hash no nome (ou ícone estático): trocou o conteúdo, troca a URL. */
function isImmutable(url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/icons/")) return true;
  return url.pathname === "/logo-mvf.png";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Qualquer coisa que não seja GET simples volta pro caminho normal do
  // navegador — basta não chamar respondWith().
  if (req.method !== "GET") return;
  if (req.mode === "navigate") return;
  if (req.headers.get("accept")?.includes("text/html")) return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.searchParams.has("_rsc")) return;
  if (url.pathname.startsWith("/api/")) return;
  if (!isImmutable(url)) return;

  event.respondWith(cacheFirst(req));
});

/** Teto do cache: cada deploy publica chunks com hash novo e os antigos ficariam
 *  para sempre. Sem isso o armazenamento só cresce no celular do atendente. */
const MAX_ENTRIES = 250;

async function trim(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_ENTRIES) return;
    // As chaves saem na ordem de inserção: descarta as mais antigas.
    await Promise.all(keys.slice(0, keys.length - MAX_ENTRIES).map((k) => cache.delete(k)));
  } catch {
    /* limpeza é best-effort */
  }
}

async function cacheFirst(request) {
  try {
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    // Só guarda resposta completa e da própria origem (nada de 206/opaque).
    if (res && res.status === 200 && res.type === "basic") {
      cache
        .put(request, res.clone())
        .then(() => {
          // De vez em quando (não a cada arquivo, para não pesar) confere o teto.
          if (Math.random() < 0.05) return trim(cache);
        })
        .catch(() => {});
    }
    return res;
  } catch {
    // Qualquer imprevisto: comporta-se como se o SW não existisse.
    return fetch(request);
  }
}

/* ------------------------------------------------------------------ *
 * Notificações push
 * ------------------------------------------------------------------ */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "MVF Chat";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    // tag = id da conversa: mensagens seguidas do mesmo cliente atualizam a
    // MESMA notificação em vez de empilhar dez avisos na tela.
    tag: data.tag || undefined,
    renotify: data.tag ? true : undefined,
    data: { url: data.url || "/atendimento" },
    vibrate: [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/atendimento";
  const url = new URL(target, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Já tem o app aberto? Foca essa janela e navega nela (não abre outra aba).
      for (const win of wins) {
        if (win.url.startsWith(self.location.origin)) {
          try {
            await win.focus();
          } catch {}
          if ("navigate" in win) {
            try {
              await win.navigate(url);
            } catch {}
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

/* Interruptor de emergência: a página manda { type: "MVF_SW_KILL" } e o SW
 * apaga os caches e se desregistra. Se algum dia o SW causar problema, dá pra
 * desligar sem esperar deploy. */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "MVF_SW_KILL") {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith("mvf-")).map((k) => caches.delete(k)));
        await self.registration.unregister();
      })(),
    );
  }
});
