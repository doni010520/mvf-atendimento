import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next 16: a antiga convenção `middleware` foi renomeada para `proxy` (runtime nodejs).
// Apenas mantém a sessão do Supabase atualizada. (A restrição por IP foi removida.)
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // `sw.js` PRECISA ficar fora: passando pelo middleware de sessão o arquivo do
  // service worker responde 307 para /login e o navegador nem chega a registrar.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest\\.json|sw\\.js|api/webhooks|api/version|api/sgp|.*\\.(?:svg|png|jpg|jpeg|gif|webp|json)$).*)"],
};
