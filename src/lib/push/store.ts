import "server-only";
import webpush from "web-push";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Armazenamento das inscrições de push (Web Push / VAPID).
 *
 * ONDE OS DADOS FICAM — leia antes de mexer:
 *
 * O lugar certo é a tabela `push_subscriptions` (migration 0027). Só que criar
 * tabela exige DDL no Supabase Cloud, que só o dono roda pelo SQL Editor. Para
 * o recurso não nascer morto esperando isso, existe um FALLBACK: enquanto a
 * tabela não existir, as inscrições ficam em `organizations.settings.push_subs`
 * (jsonb que já existe). A troca é automática: assim que a migration rodar, o
 * código passa a usar a tabela sozinho, sem deploy.
 *
 * São poucos registros (um por aparelho de atendente), então o jsonb aguenta
 * com folga. O fallback é uma ponte, não o destino.
 */

export type StoredSub = {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string | null;
  created_at?: string;
};

type DB = ReturnType<typeof createServiceClient>;

const TABLE = "push_subscriptions";

/**
 * Cache do "a tabela existe?" — evita uma consulta extra a cada push.
 *
 * O "não existe" tem prazo de validade (10 min): quando o dono rodar a migration,
 * o container percebe sozinho, sem precisar de restart. O "existe" fica cacheado
 * para sempre (tabela não some).
 */
let tableExists: boolean | null = null;
let checkedAt = 0;
const RECHECK_MS = 10 * 60 * 1000;

export async function hasTable(db: DB): Promise<boolean> {
  if (tableExists === true) return true;
  if (tableExists === false && Date.now() - checkedAt < RECHECK_MS) return false;

  const { error } = await db.from(TABLE).select("endpoint").limit(1);
  checkedAt = Date.now();
  // Qualquer erro (tabela ausente — PGRST205/42P01 — ou falha transitória) cai no
  // fallback jsonb. Errar para o lado do fallback só custa um pulo de local; errar
  // para o lado da tabela perderia a inscrição do atendente.
  tableExists = !error;
  return tableExists;
}

/* ---------------------------- fallback jsonb ---------------------------- */

async function readSettings(db: DB, orgId: string): Promise<Record<string, unknown>> {
  const { data } = await db.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  return (data?.settings ?? {}) as Record<string, unknown>;
}

/** Escreve preservando o resto do settings (read-modify-write no último instante). */
async function writeSettingsKey(db: DB, orgId: string, key: string, value: unknown) {
  const current = await readSettings(db, orgId);
  await db
    .from("organizations")
    .update({ settings: { ...current, [key]: value } })
    .eq("id", orgId);
}

function subsFromSettings(settings: Record<string, unknown>): StoredSub[] {
  const raw = settings["push_subs"];
  return Array.isArray(raw) ? (raw as StoredSub[]) : [];
}

/* ------------------------------ inscrições ------------------------------ */

export async function saveSubscription(db: DB, orgId: string, sub: StoredSub): Promise<void> {
  if (await hasTable(db)) {
    await db.from(TABLE).upsert(
      {
        organization_id: orgId,
        user_id: sub.user_id,
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        user_agent: sub.user_agent ?? null,
      },
      { onConflict: "endpoint" },
    );
    return;
  }
  const settings = await readSettings(db, orgId);
  const list = subsFromSettings(settings).filter((s) => s.endpoint !== sub.endpoint);
  list.push({ ...sub, created_at: new Date().toISOString() });
  // Teto de segurança: aparelho antigo cai fora antes de o jsonb crescer demais.
  const trimmed = list.slice(-200);
  await db
    .from("organizations")
    .update({ settings: { ...settings, push_subs: trimmed } })
    .eq("id", orgId);
}

export async function removeSubscription(db: DB, orgId: string, endpoint: string): Promise<void> {
  if (await hasTable(db)) {
    await db.from(TABLE).delete().eq("endpoint", endpoint);
    return;
  }
  const settings = await readSettings(db, orgId);
  const list = subsFromSettings(settings).filter((s) => s.endpoint !== endpoint);
  await db
    .from("organizations")
    .update({ settings: { ...settings, push_subs: list } })
    .eq("id", orgId);
}

export async function listSubscriptions(db: DB, orgId: string, userIds?: string[]): Promise<StoredSub[]> {
  if (userIds && userIds.length === 0) return [];
  if (await hasTable(db)) {
    let q = db.from(TABLE).select("user_id, endpoint, p256dh, auth").eq("organization_id", orgId);
    if (userIds) q = q.in("user_id", userIds);
    const { data } = await q;
    return (data ?? []) as StoredSub[];
  }
  const list = subsFromSettings(await readSettings(db, orgId));
  return userIds ? list.filter((s) => userIds.includes(s.user_id)) : list;
}

/* -------------------------------- VAPID -------------------------------- */

export type Vapid = { publicKey: string; privateKey: string; subject: string };

const vapidCache = new Map<string, Vapid>();

/**
 * Par de chaves VAPID (identidade do servidor junto ao serviço de push).
 *
 * Ordem: variável de ambiente → chave já salva no banco → gera e salva.
 * O passo "gera e salva" é de propósito: sem ele o push só funcionaria depois
 * de alguém entrar no Easypanel e cadastrar env var, o que trava o recurso por
 * tempo indeterminado. Trocar por env var depois é seguro — ela tem prioridade
 * (mas trocar a chave invalida as inscrições existentes: cada aparelho precisa
 * ativar de novo).
 */
export async function getVapid(db: DB, orgId: string): Promise<Vapid | null> {
  const subject = process.env.VAPID_SUBJECT || process.env.APP_BASE_URL || "https://mvfchat.benitechlab.com";

  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv, subject };

  const cached = vapidCache.get(orgId);
  if (cached) return cached;

  try {
    const settings = await readSettings(db, orgId);
    const saved = settings["push_vapid"] as { publicKey?: string; privateKey?: string } | undefined;
    if (saved?.publicKey && saved?.privateKey) {
      const v = { publicKey: saved.publicKey, privateKey: saved.privateKey, subject };
      vapidCache.set(orgId, v);
      return v;
    }

    const generated = webpush.generateVAPIDKeys();
    await writeSettingsKey(db, orgId, "push_vapid", {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      created_at: new Date().toISOString(),
    });

    // Relê antes de usar: durante um deploy existem dois containers por alguns
    // segundos e os dois podem gerar par de chaves ao mesmo tempo. Vale o que
    // ficou GRAVADO — senão um container assinaria com uma chave que o outro
    // sobrescreveu e as notificações desses aparelhos morreriam calado.
    const confirmed = (await readSettings(db, orgId))["push_vapid"] as
      | { publicKey?: string; privateKey?: string }
      | undefined;
    const v = {
      publicKey: confirmed?.publicKey ?? generated.publicKey,
      privateKey: confirmed?.privateKey ?? generated.privateKey,
      subject,
    };
    vapidCache.set(orgId, v);
    return v;
  } catch {
    return null;
  }
}
