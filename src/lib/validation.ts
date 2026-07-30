import { z } from "zod";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Remove tudo que não seja dígito. */
const digits = (v: string) => v.replace(/\D/g, "");

function cpfValid(v: string): boolean {
  const d = digits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 || r === 11 ? 0 : r;
  };
  return calc(9) === parseInt(d[9]) && calc(10) === parseInt(d[10]);
}

function cnpjValid(v: string): boolean {
  const d = digits(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (weights: number[]) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += parseInt(d[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  return calc(w1) === parseInt(d[12]) && calc(w2) === parseInt(d[13]);
}

// ─── Primitivos reutilizáveis ─────────────────────────────────────────────────

export const zUuid = z.string().uuid("ID inválido.");

export const zName = z
  .string()
  .min(1, "Nome obrigatório.")
  .max(100, "Nome muito longo.")
  .transform((v) => v.trim());

export const zEmail = z
  .string()
  .email("E-mail inválido.")
  .max(254)
  .transform((v) => v.trim().toLowerCase());

export const zPassword = z.string().min(6, "Senha com no mínimo 6 caracteres.");

export const zHexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{3,8}$/, "Cor inválida (ex.: #00a8ff).")
  .default("#00a8ff");

export const zUrl = z.string().url("URL inválida.").max(500);

export const zCpfCnpj = z
  .string()
  .transform(digits)
  .refine(
    (v) => v === "" || cpfValid(v) || cnpjValid(v),
    "CPF ou CNPJ inválido.",
  );

export const zRole = z.enum(["admin", "agent"], {
  error: () => "Perfil inválido.",
});

// "Sem departamento" no <select> manda string vazia — que NÃO é uuid nem null.
// Tratamos "" (e undefined) como null antes de validar, senão o parse estoura
// e a tela de editar atendente quebra com erro de Server Component.
export const zDepartmentId = z.preprocess(
  (v) => (v === "" || v == null ? null : v),
  z.string().uuid("Departamento inválido.").nullable(),
);

export const zChannelType = z.enum(["uazapi", "meta_cloud"], {
  error: () => "Tipo de canal inválido.",
});

// ─── Schemas de actions ───────────────────────────────────────────────────────

export const OrgSchema = z.object({
  name: zName,
  document: zCpfCnpj.optional(),
});

export const AgentCreateSchema = z.object({
  name: zName,
  email: zEmail,
  password: zPassword,
  role: zRole,
  department_id: zDepartmentId,
});

export const AgentUpdateSchema = z.object({
  name: zName,
  role: zRole,
  department_id: zDepartmentId,
  // Valores reais do sistema (Profile.status): online | away | offline.
  // Antes estava "busy", que não existe no form nem no tipo — quebrava quem
  // escolhesse "Ausente".
  status: z.enum(["online", "away", "offline"]).default("offline"),
});

export const DepartmentSchema = z.object({
  name: zName,
  color: zHexColor,
});

export const ChannelCreateSchema = z.object({
  type: zChannelType,
  name: zName,
  phone: z.string().transform(digits).optional(),
  phone_number_id: z.string().max(50).optional(),
  waba_id: z.string().max(50).optional(),
  access_token: z.string().max(1000).optional(),
});

export const IntegrationSchema = z.object({
  url: zUrl,
  app: z.string().min(1, "App obrigatório.").max(100),
  token: z.string().max(256).optional(),
  username: z.string().max(100).optional(),
  password: z.string().max(256).optional(),
});

export const AutomationSchema = z.object({
  name: zName,
  channel_id: z.string().uuid("Canal inválido.").nullable().optional(),
  integration_id: z.string().uuid("Integração inválida.").nullable().optional(),
  trigger: z.string().max(200).nullable().optional(),
});

export const DepartmentTagSchema = z.object({
  name: zName,
  color: zHexColor,
});

// ─── Utilidade ────────────────────────────────────────────────────────────────

/** Lê um FormData para um objeto plano, ignorando entradas nulas. */
export function fdToObj(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Valida e lança com mensagem amigável. */
export function parse<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => i.message).join("; ");
    throw new Error(msg);
  }
  return result.data;
}
