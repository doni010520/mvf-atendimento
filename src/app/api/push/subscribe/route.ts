import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { removeSubscription, saveSubscription } from "@/lib/push/store";
import { logEvent } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

/** Registra o aparelho do atendente para receber notificações. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.organization) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ ok: false, error: "indisponível" }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "corpo inválido" }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint.startsWith("https://") || !p256dh || !auth) {
    return NextResponse.json({ ok: false, error: "inscrição inválida" }, { status: 400 });
  }

  try {
    await saveSubscription(createServiceClient(), session.organization.id, {
      user_id: session.userId,
      endpoint,
      p256dh,
      auth,
      user_agent: (request.headers.get("user-agent") ?? "").slice(0, 300),
    });
    void logEvent("info", "push", "Aparelho inscrito para notificações", {
      user: session.profile?.name ?? session.userId,
    }, session.organization.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    void logEvent("error", "push", "Falha ao salvar inscrição de push", {
      error: String((err as Error)?.message ?? err),
    }, session.organization.id);
    return NextResponse.json({ ok: false, error: "falha ao salvar" }, { status: 500 });
  }
}

/** Desliga as notificações naquele aparelho. */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session?.organization) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ ok: false, error: "indisponível" }, { status: 503 });
  }

  let endpoint = "";
  try {
    endpoint = String(((await request.json()) as Body).endpoint ?? "");
  } catch {
    /* corpo vazio: nada a remover */
  }
  if (!endpoint) return NextResponse.json({ ok: true });

  try {
    await removeSubscription(createServiceClient(), session.organization.id, endpoint);
  } catch {
    /* remover é best-effort: o 404/410 no envio também limpa */
  }
  return NextResponse.json({ ok: true });
}
