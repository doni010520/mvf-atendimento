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

/**
 * Variante do MESMO celular BR com/sem o nono dígito (5573 8xxxxxxx <-> 5573 98xxxxxxx).
 * DDD e os 8 últimos dígitos são iguais; só o "9" muda. Devolve null quando não
 * há variante (número curto, estrangeiro, grupo).
 */
export function phoneVariant(raw: string): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (!d.startsWith("55")) return null;
  if (d.length === 13 && d[4] === "9") return d.slice(0, 4) + d.slice(5); // tira o 9
  if (d.length === 12) return d.slice(0, 4) + "9" + d.slice(4);           // põe o 9
  return null;
}

/**
 * Extrai o wa_id (número REAL do WhatsApp) de um id de mensagem da Meta.
 * O `wamid` carrega o número em base64 — e ele é a ÚNICA fonte confiável:
 * na Bahia 93% dos wa_id vêm SEM o nono dígito, enquanto canonicalPhone()
 * SEMPRE adiciona o 9 ao gravar o contato. Enviar para o número com o 9 a
 * mais é tolerado pela Meta na maioria dos casos, mas em parte deles volta
 * "131026 Message Undeliverable" — a mensagem do atendente simplesmente não
 * chega, sem aviso na tela (incidente Marianna Gama, 02/09).
 */
export function waIdFromWamid(wamid?: string | null): string | null {
  if (!wamid || !wamid.startsWith("wamid.")) return null;
  try {
    const b64 = wamid.slice(6);
    const bin = typeof Buffer !== "undefined"
      ? Buffer.from(b64 + "==", "base64").toString("latin1")
      : atob(b64 + "==");
    const m = bin.match(/[0-9]{10,15}/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}
