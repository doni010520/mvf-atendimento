import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { sendPushToUsers } from "@/lib/push/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dispara uma notificação de teste para os aparelhos do PRÓPRIO usuário logado.
 *
 * Existe para o atendente conseguir conferir sozinho que ficou funcionando, em
 * vez de esperar um cliente mandar mensagem para descobrir que não chegou.
 * Só alcança quem pediu — não dá para usar isso para cutucar colega.
 */
export async function POST() {
  const session = await getSession();
  if (!session?.organization) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ ok: false, error: "indisponível" }, { status: 503 });
  }

  const { sent } = await sendPushToUsers(createServiceClient(), session.organization.id, [session.userId], {
    title: "MVF Chat",
    body: "Notificação de teste — está funcionando ✅",
    url: "/atendimento",
    tag: "teste",
  });

  return NextResponse.json({ ok: true, sent });
}
