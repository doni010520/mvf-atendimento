/**
 * Teste do contrato do service worker — rode com `node scripts/sw-check.mjs`.
 *
 * O perigo do SW neste app não é ele deixar de cachear: é ele cachear DEMAIS.
 * HTML ou payload RSC servidos do cache reproduzem o "Failed to find Server
 * Action" direto no aparelho do atendente, onde F5 não resolve. Este teste
 * carrega o public/sw.js num `self` falso e confere, requisição por requisição,
 * quem ele intercepta e quem ele deixa passar para a rede.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, "..", "public", "sw.js"), "utf8");

const handlers = {};
const self = {
  addEventListener: (type, fn) => {
    handlers[type] = fn;
  },
  location: { origin: "https://mvfchat.benitechlab.com" },
  registration: { showNotification: () => {} },
  clients: { matchAll: async () => [], openWindow: async () => {}, claim: async () => {} },
  skipWaiting: () => {},
};
const context = {
  self,
  caches: { keys: async () => [], open: async () => ({}), delete: async () => true },
  fetch: async () => ({ status: 200, type: "basic", clone: () => ({}) }),
  URL,
  URLSearchParams,
  Promise,
  Math,
  console,
};
vm.createContext(context);
vm.runInContext(code, context);

/** Roda o handler de fetch e responde: o SW assumiu esta requisição? */
function intercepta({ url, method = "GET", mode = "cors", accept = "*/*" }) {
  let respondeu = false;
  const event = {
    request: {
      url,
      method,
      mode,
      headers: { get: (h) => (h.toLowerCase() === "accept" ? accept : null) },
    },
    respondWith: () => {
      respondeu = true;
    },
  };
  handlers.fetch(event);
  return respondeu;
}

const O = "https://mvfchat.benitechlab.com";
const casos = [
  // [descrição, requisição, deve interceptar?]
  ["chunk JS com hash", { url: `${O}/_next/static/chunks/abc123.js` }, true],
  ["CSS com hash", { url: `${O}/_next/static/chunks/x.css` }, true],
  ["ícone do PWA", { url: `${O}/icons/icon-192.png` }, true],
  ["logo", { url: `${O}/logo-mvf.png` }, true],

  ["navegação (HTML)", { url: `${O}/atendimento`, mode: "navigate", accept: "text/html" }, false],
  ["documento HTML por accept", { url: `${O}/clientes`, accept: "text/html,application/xhtml+xml" }, false],
  ["payload RSC", { url: `${O}/atendimento?_rsc=1a2b3` }, false],
  ["Server Action (POST)", { url: `${O}/atendimento`, method: "POST" }, false],
  ["upload de mídia (POST)", { url: `${O}/api/atendimento/enviar-midia?x=1`, method: "POST" }, false],
  ["rota de API", { url: `${O}/api/version` }, false],
  ["push subscribe", { url: `${O}/api/push/subscribe`, method: "POST" }, false],
  ["Supabase (outra origem)", { url: "https://xzhzbefkxfgvwfqztqan.supabase.co/rest/v1/messages" }, false],
  ["mídia no Supabase Storage", { url: "https://xzhzbefkxfgvwfqztqan.supabase.co/storage/v1/object/x.mp3" }, false],
  ["manifest", { url: `${O}/manifest.json` }, false],
  ["o próprio sw.js", { url: `${O}/sw.js` }, false],
];

let falhas = 0;
for (const [nome, req, esperado] of casos) {
  const real = intercepta(req);
  const ok = real === esperado;
  if (!ok) falhas++;
  console.log(
    `${ok ? "ok  " : "FALHA"}  ${nome.padEnd(28)} → ${real ? "intercepta" : "passa direto"}` +
      (ok ? "" : `  (esperado: ${esperado ? "intercepta" : "passa direto"})`),
  );
}

// Os handlers de push precisam existir, senão a notificação não aparece.
for (const h of ["push", "notificationclick", "install", "activate", "message"]) {
  const ok = typeof handlers[h] === "function";
  if (!ok) falhas++;
  console.log(`${ok ? "ok  " : "FALHA"}  handler "${h}"`);
}

console.log(falhas === 0 ? "\nTudo certo." : `\n${falhas} falha(s).`);
process.exit(falhas === 0 ? 0 : 1);
