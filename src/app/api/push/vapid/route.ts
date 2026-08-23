import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getVapid } from "@/lib/push/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Chave PÚBLICA VAPID para o navegador se inscrever no push.
 *
 * É buscada em runtime (e não embutida como NEXT_PUBLIC_* no build) de propósito:
 * assim ligar o push não exige rebuild da imagem nem mexer no Easypanel.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.organization) {
    return NextResponse.json({ ok: false, error: "não autenticado" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ ok: false, error: "indisponível" }, { status: 503 });
  }

  const vapid = await getVapid(createServiceClient(), session.organization.id);
  if (!vapid) {
    return NextResponse.json({ ok: false, error: "indisponível" }, { status: 503 });
  }

  return NextResponse.json(
    { ok: true, publicKey: vapid.publicKey },
    { headers: { "Cache-Control": "no-store" } },
  );
}
