import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPhone(raw?: string | null): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  if (d.length === 13) return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 9)} ${d.slice(9)}`;
  if (d.length === 12) return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 8)} ${d.slice(8)}`;
  return raw;
}

/**
 * Normaliza celular BR pra forma canônica (55 + DDD + 9 dígitos) antes de
 * gravar/buscar em contacts.phone. Sem isso, o mesmo contato grava com
 * formatos diferentes conforme a origem (webhook inbound vs atendente
 * digitando/colando número exportado do SGP, que vem SEM o "55") e o
 * upsert por onConflict(phone) não casa — gera contato duplicado e, por
 * consequência, conversa duplicada quando o cliente responde um template
 * enviado pro número "errado" (caso Luana, 19/08: 377 contatos gravados
 * sem "55" — todo mundo com número no formato nacional do SGP colado direto).
 */
export function canonicalPhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  // Sem código do país: DDD(2) + numero(8 ou 9) = 10 ou 11 dígitos.
  if (!d.startsWith("55") && (d.length === 10 || d.length === 11)) d = `55${d}`;
  if (d.startsWith("55") && d.length === 12) return d.slice(0, 4) + "9" + d.slice(4);
  return d;
}
