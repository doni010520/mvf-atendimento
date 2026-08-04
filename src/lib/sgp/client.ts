import {
  type SgpConfig,
  type SgpCliente,
  type SgpContrato,
  type SgpTitulo,
  type SgpSegundaVia,
  type SgpAcaoResult,
  type SgpConexao,
  type SgpOnu,
  SgpError,
} from "./types";

/**
 * Cliente da API de integração (URA) do SGP.
 *
 * Autenticação (conforme a collection oficial): HTTP Basic (username/password,
 * quando a instância exige) + `app` (nome da aplicação) e `token` no corpo.
 * A maioria dos endpoints recebe `application/x-www-form-urlencoded`; alguns
 * (ex.: criar chamado, que envia arrays) recebem JSON.
 *
 * Os normalizadores são defensivos: o SGP varia nomes de campo entre versões
 * (camelCase vs minúsculo). Preservamos a resposta crua em `raw`.
 */
export class SgpClient {
  private base: string;
  private app: string;
  private token: string;
  private authHeader?: string;
  /** Timeout por requisição. O SGP pode pendurar em inputs patológicos
   *  (ex.: cpfcnpj "00000000000"); sem isso a IA travaria indefinidamente. */
  private timeoutMs = 15000;

  constructor(config: SgpConfig) {
    if (!config.url) throw new SgpError("SGP: URL não configurada.");
    if (!config.app) throw new SgpError("SGP: nome da aplicação (app) não configurado.");
    if (!config.token) throw new SgpError("SGP: token não configurado.");
    this.base = config.url.replace(/\/+$/, "");
    this.app = config.app;
    this.token = config.token;
    if (config.username && config.password) {
      this.authHeader = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
    }
  }

  /** fetch com timeout (AbortController) — falha rápido se o SGP não responder. */
  private async fetchT(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        throw new SgpError(`SGP: tempo esgotado (${this.timeoutMs}ms) — servidor não respondeu.`);
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  private headers(contentType: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": contentType, Accept: "application/json" };
    if (this.authHeader) h.Authorization = this.authHeader;
    return h;
  }

  private async parse(res: Response, path: string): Promise<unknown> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = text;
    }
    if (!res.ok) throw new SgpError(`SGP ${path} -> ${res.status}`, res.status, json);
    return json;
  }

  /** POST form-urlencoded. Inclui app+token automaticamente; ignora campos vazios/undefined. */
  async postForm<T = unknown>(path: string, fields: Record<string, unknown> = {}): Promise<T> {
    const params = new URLSearchParams();
    params.set("app", this.app);
    params.set("token", this.token);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
    const url = `${this.base}/${path.replace(/^\/+/, "")}`;
    let res: Response;
    try {
      res = await this.fetchT(url, { method: "POST", headers: this.headers("application/x-www-form-urlencoded"), body: params.toString() });
    } catch (e) {
      if (e instanceof SgpError) throw e;
      throw new SgpError(`SGP: falha de rede em ${path}: ${(e as Error).message}`);
    }
    return this.parse(res, path) as Promise<T>;
  }

  /** GET com app+token (e demais campos) na query string. Usado nas rotas FTTH. */
  async getQuery<T = unknown>(path: string, fields: Record<string, unknown> = {}): Promise<T> {
    const params = new URLSearchParams();
    params.set("app", this.app);
    params.set("token", this.token);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
    const url = `${this.base}/${path.replace(/^\/+/, "")}?${params.toString()}`;
    let res: Response;
    try {
      res = await this.fetchT(url, { method: "GET", headers: { Accept: "application/json", ...(this.authHeader ? { Authorization: this.authHeader } : {}) } });
    } catch (e) {
      if (e instanceof SgpError) throw e;
      throw new SgpError(`SGP: falha de rede em ${path}: ${(e as Error).message}`);
    }
    return this.parse(res, path) as Promise<T>;
  }

  /** POST JSON. Inclui app+token no corpo. */
  async postJson<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.base}/${path.replace(/^\/+/, "")}`;
    let res: Response;
    try {
      res = await this.fetchT(url, {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify({ app: this.app, token: this.token, ...body }),
      });
    } catch (e) {
      if (e instanceof SgpError) throw e;
      throw new SgpError(`SGP: falha de rede em ${path}: ${(e as Error).message}`);
    }
    return this.parse(res, path) as Promise<T>;
  }

  /* ------------------------------ serviços ------------------------------ */

  /** Consulta o assinante por CPF/CNPJ, telefone ou contrato. POST /api/ura/consultacliente/ */
  async consultarCliente(by: { cpfcnpj?: string; telefone?: string; contrato?: number }): Promise<SgpCliente> {
    const raw = await this.postForm<Record<string, unknown>>("api/ura/consultacliente/", {
      cpfcnpj: by.cpfcnpj ? onlyDigits(by.cpfcnpj) : undefined,
      telefone: by.telefone ? onlyDigits(by.telefone) : undefined,
      contrato: by.contrato,
    });
    return normalizeCliente(raw);
  }

  /** Lista títulos (faturas) por contrato ou CPF/CNPJ. status=1 → em aberto. POST /api/ura/titulos/ */
  async listarTitulos(by: { contrato?: number; cpfcnpj?: string; status?: number; limit?: number }): Promise<SgpTitulo[]> {
    const raw = await this.postForm<Record<string, unknown>>("api/ura/titulos/", {
      contrato: by.contrato,
      cpfcnpj: by.cpfcnpj ? onlyDigits(by.cpfcnpj) : undefined,
      status: by.status,
      limit: by.limit ?? 50,
    });
    return normalizeTitulos(raw);
  }

  /**
   * Atalho: só os títulos realmente cobráveis (filtra localmente).
   *
   * Duas regras importantes — o SGP devolve a lista em ordem arbitrária (na
   * prática, id decrescente = fatura MAIS FUTURA primeiro) e mistura títulos
   * cancelados junto dos abertos:
   *  - exclui pagos E cancelados (cancelado não pode virar cobrança);
   *  - ordena por vencimento CRESCENTE, para que `[0]` seja sempre a fatura
   *    mais antiga em aberto — a que o cliente deve pagar primeiro.
   * Sem isso, o PIX/2ª via saía com uma fatura de meses no futuro.
   */
  async titulosEmAberto(by: { contrato?: number; cpfcnpj?: string }): Promise<SgpTitulo[]> {
    const list = await this.listarTitulos(by);
    return list
      .filter((t) => !t.pago && !t.cancelado)
      .sort((a, b) => String(a.vencimento ?? "").localeCompare(String(b.vencimento ?? "")));
  }

  /** Gera/retorna a 2ª via (linha digitável + link, uma ou várias faturas). POST /api/ura/fatura2via/ */
  async segundaVia(by: { contrato?: number; cpfcnpj?: string; linkPdf?: boolean }): Promise<SgpSegundaVia> {
    const raw = await this.postForm<Record<string, unknown>>("api/ura/fatura2via/", {
      contrato: by.contrato,
      cpfcnpj: by.cpfcnpj ? onlyDigits(by.cpfcnpj) : undefined,
      link_pdf: by.linkPdf ? 1 : undefined,
    });
    return normalizeSegundaVia(raw);
  }

  /** Gera o PIX (copia-e-cola) de uma fatura. POST /api/ura/pagamento/pix/{fatura} */
  async gerarPix(fatura: number, contrato?: number): Promise<{ ok: boolean; codigoPix?: string; raw?: unknown }> {
    const raw = await this.postForm<Record<string, unknown>>(`api/ura/pagamento/pix/${fatura}`, { contrato });
    const codigoPix = pickStr(raw, ["codigoPix", "codigopix", "pix", "qrcode", "emv"]);
    return { ok: !!codigoPix || (pickBool(raw, ["status", "sucesso"]) ?? false), codigoPix, raw };
  }

  /** Envia a fatura ao cliente por e-mail/SMS/WhatsApp. tipo: 1=email,2=sms... POST /api/ura/enviafatura/ */
  async enviarFatura(by: { contrato: number; tipo?: number; email?: string; celular?: string; mensagem?: string }): Promise<SgpAcaoResult> {
    const raw = await this.postForm<Record<string, unknown>>("api/ura/enviafatura/", {
      contrato: by.contrato,
      tipo: by.tipo,
      email: by.email,
      celular: by.celular ? onlyDigits(by.celular) : undefined,
      mensagem: by.mensagem,
    });
    return normalizeAcao(raw);
  }

  /** Liberação por confiança (promessa de pagamento) de um contrato. POST /api/ura/liberacaopromessa/ */
  async liberacaoConfianca(by: { contrato: number; dataPromessa?: string; contato?: string }): Promise<SgpAcaoResult> {
    const raw = await this.postForm<Record<string, unknown>>("api/ura/liberacaopromessa/", {
      contrato: by.contrato,
      data_promessa: by.dataPromessa,
      uracontato: by.contato,
    });
    const r = normalizeAcao(raw);
    r.ok = (pickBool(raw, ["liberado"]) ?? r.ok);
    return r;
  }

  /** Verifica o status de conexão/acesso de um contrato. POST /api/ura/verificaacesso/ */
  async statusConexao(by: { contrato?: number; telefone?: string }): Promise<SgpConexao> {
    const raw = await this.postForm<Record<string, unknown>>("api/ura/verificaacesso/", {
      contrato: by.contrato,
      telefone: by.telefone ? onlyDigits(by.telefone) : undefined,
    });
    const msg = pickStr(raw, ["msg", "mensagem"]) ?? "";
    return {
      contrato: pickNum(raw, ["contrato", "contratoId"]),
      online: !/offline/i.test(msg) && (pickStr(raw, ["status"]) === undefined ? true : pickNum(raw, ["status"]) === 1),
      mensagem: msg || undefined,
      raw,
    };
  }

  /** Lista as ONUs (equipamentos de fibra) por contrato ou CPF/CNPJ. GET /api/fttx/onu/list/ */
  async listarOnus(by: { contrato?: number; cpfcnpj?: string }): Promise<SgpOnu[]> {
    const raw = await this.getQuery<unknown>("api/fttx/onu/list/", {
      contrato: by.contrato,
      cpfcnpj: by.cpfcnpj ? onlyDigits(by.cpfcnpj) : undefined,
    });
    return asArray(raw)
      .filter((o) => pick(o, ["id"]) != null)
      .map((o) => ({
        id: pickNum(o, ["id"]) ?? 0,
        onuid: pickNum(o, ["onuid"]),
        oltName: pickStr(o, ["olt_name"]),
        descricao: pickStr(o, ["description"]),
        phyAddr: pickStr(o, ["phy_addr"]),
        status: pickStr(o, ["status", "connection"]),
        sinalRx: pickStr(o, ["info_rx"]),
        raw: o,
      }));
  }

  /**
   * Baixa o PDF do CONTRATO do cliente. GET /api/contratos/print/{tipo}.
   * Pegadinha do SGP: o endpoint só aceita GET **com os parâmetros no CORPO**
   * (form), o que o fetch() proíbe — por isso usamos node:https direto.
   * tipos: contrato | termoadesao | contratofidelidade | cancelamento |
   *        termocomodato | termoaceite_web | termoprivacidade
   */
  async contratoPdf(contrato: number, tipo = "contrato"): Promise<Buffer | null> {
    const { request } = await import("node:https");
    const body = new URLSearchParams({ app: this.app, token: this.token, contrato: String(contrato) }).toString();
    const u = new URL(`${this.base}/api/contratos/print/${tipo}`);
    return new Promise((resolve) => {
      const req = request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: "GET",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const isPdf = res.statusCode === 200 && buf.subarray(0, 5).toString() === "%PDF-";
            resolve(isPdf ? buf : null);
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  }

  /** Lista os gateways de SMS configurados no SGP. GET /api/sms/gateway/list/ */
  async listarGatewaysSms(): Promise<{ id: number; descricao?: string; gateway?: string }[]> {
    const raw = await this.getQuery<unknown>("api/sms/gateway/list/");
    return asArray(raw)
      .filter((g) => pick(g, ["id"]) != null)
      .map((g) => ({ id: pickNum(g, ["id"]) ?? 0, descricao: pickStr(g, ["descricao"]), gateway: pickStr(g, ["gateway"]) }));
  }

  /**
   * Dispara um SMS de VERDADE pelo gateway do SGP (ex.: Facilita).
   * GET /api/sms/send/  phone: DDD+numero (sem 55); aceita vários por vírgula.
   * A resposta de sucesso observada é o literal "OK".
   */
  async enviarSms(by: { phone: string; msg: string; gateway: number; idcontrato?: number; linkUrl?: string }): Promise<{ ok: boolean; raw?: unknown }> {
    const raw = await this.getQuery<unknown>("api/sms/send/", {
      phone: by.phone,
      msg: by.msg,
      gateway: by.gateway,
      idcontrato: by.idcontrato,
      link_url: by.linkUrl,
    });
    const s = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    const ok = /ok|sucesso|"status"\s*:\s*1/i.test(s) && !/erro|error|inv[aá]lid/i.test(s);
    return { ok, raw };
  }

  /** Reinicia (reset) remotamente uma ONU pelo seu id. GET /api/fttx/onu/{id}/reset/ */
  async resetarOnu(idOnu: number): Promise<{ ok: boolean; mensagem?: string; raw?: unknown }> {
    const raw = await this.getQuery<Record<string, unknown>>(`api/fttx/onu/${idOnu}/reset/`);
    // A resposta varia; consideramos sucesso se não houver erro explícito.
    const status = pickNum(raw, ["status"]);
    const erro = pick(raw, ["erro", "error"]);
    const ok = status != null ? status === 1 : !erro;
    return { ok, mensagem: pickStr(raw, ["msg", "mensagem", "detalhe", "erro"]), raw };
  }

  /** Abre um chamado/O.S. de suporte. POST /api/ura/chamado/ (JSON; aceita arrays). */
  async abrirChamado(params: {
    contrato: number;
    ocorrenciatipo: number;
    tipoclassificacoes?: number[];
    conteudo?: string;
  }): Promise<SgpAcaoResult> {
    const raw = await this.postJson<unknown>("api/ura/chamado/", {
      contrato: params.contrato,
      ocorrenciatipo: params.ocorrenciatipo,
      tipoclassificacoes: params.tipoclassificacoes ?? [],
      conteudo: params.conteudo,
    });
    // pode vir objeto único ou array (uma O.S.)
    const obj = Array.isArray(raw) ? (raw[0] as Record<string, unknown>) : (raw as Record<string, unknown>);
    const r = normalizeAcao(obj);
    r.protocolo = pickStr(obj, ["protocolo", "os_protocolo"]) ?? r.protocolo;
    return r;
  }

  /** Lista os tipos de ocorrência (para escolher `ocorrenciatipo` ao abrir chamado). */
  async listarTiposOcorrencia(): Promise<{ id: number; nome: string }[]> {
    const raw = await this.postForm<unknown>("api/ura/ocorrencia/metodo/list/", {});
    return asArray(raw)
      .map((o) => ({ id: pickNum(o, ["id"]) ?? 0, nome: pickStr(o, ["nome", "descricao", "titulo"]) ?? "" }))
      .filter((o) => o.id);
  }
}

/* ----------------------------- normalizadores ----------------------------- */

const onlyDigits = (s: string) => s.replace(/\D+/g, "");

function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") return [v as Record<string, unknown>];
  return [];
}
function pick(o: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) if (o[k] != null && o[k] !== "") return o[k];
  return undefined;
}
function pickStr(o: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  const v = pick(o, keys);
  return v == null ? undefined : String(v).trim();
}
function pickNum(o: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  const v = pick(o, keys);
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isNaN(n) ? undefined : n;
}
function pickBool(o: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  const v = pick(o, keys);
  if (v == null) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return ["1", "true", "sim", "s", "ok"].includes(s);
}

function normalizeContrato(c: Record<string, unknown>): SgpContrato {
  const end = [
    pickStr(c, ["endereco_logradouro"]),
    pickNum(c, ["endereco_numero"]),
    pickStr(c, ["endereco_bairro"]),
    [pickStr(c, ["endereco_cidade"]), pickStr(c, ["endereco_uf"])].filter(Boolean).join("/"),
  ].filter(Boolean).join(", ");
  return {
    contrato: pickNum(c, ["contratoId", "contrato", "id"]) ?? 0,
    status: pickStr(c, ["contratoStatusDisplay", "status", "situacao"]),
    statusModo: pickNum(c, ["contratoStatusModo"]),
    motivoStatus: pickStr(c, ["motivo_status"]),
    plano: pickStr(c, ["planointernet", "servico_plano", "plano"]),
    login: pickStr(c, ["servico_login", "contratoCentralLogin", "login"]),
    tipoConexao: pickStr(c, ["servico_tipo_conexao"]),
    valorEmAberto: pickNum(c, ["contratoValorAberto"]),
    titulosAReceber: pickNum(c, ["contratoTitulosAReceber"]),
    endereco: end || pickStr(c, ["endereco"]),
    pop: pickStr(c, ["popNome", "pop"]),
  };
}

export function normalizeCliente(raw: Record<string, unknown>): SgpCliente {
  const contratosRaw = asArray(raw.contratos ?? raw.contrato);
  const msg = pickStr(raw, ["msg", "mensagem"]) ?? "";
  const first = contratosRaw[0];
  const encontrado = contratosRaw.length > 0 && !/n[ãa]o\s+(localizad|encontrad)/i.test(msg);
  return {
    encontrado,
    mensagem: msg || undefined,
    clienteId: pickNum(first, ["clienteId"]),
    nome: pickStr(first, ["razaoSocial", "razaosocial", "nome"]),
    cpfcnpj: pickStr(first, ["cpfCnpj", "cpfcnpj"]),
    emails: Array.isArray(first?.emails) ? (first!.emails as string[]) : undefined,
    telefones: Array.isArray(first?.telefones) ? (first!.telefones as string[]) : undefined,
    contratos: contratosRaw.map(normalizeContrato),
    raw,
  };
}

const PAGO = /pag|liquidad|quitad|baixad/i;
// "cancelado"/"estornado" NÃO é cobrável — o SGP devolve esses títulos
// misturados com os abertos na mesma listagem.
const CANCELADO = /cancelad|estornad/i;

export function normalizeTitulos(raw: Record<string, unknown>): SgpTitulo[] {
  const list = asArray(raw.titulos ?? raw.faturas ?? raw);
  return list
    .filter((t) => pick(t, ["id", "fatura"]) != null)
    .map((t) => {
      const status = pickStr(t, ["status", "situacao"]);
      return {
        fatura: pickNum(t, ["id", "fatura"]) ?? 0,
        numeroDocumento: pickNum(t, ["numeroDocumento", "numero_documento"]),
        contrato: pickNum(t, ["clienteContrato", "cliente_contrato", "contrato"]),
        valor: pickNum(t, ["valor"]) ?? 0,
        valorCorrigido: pickNum(t, ["valorCorrigido", "valorcorrigido"]),
        vencimento: pickStr(t, ["dataVencimento", "vencimento_atualizado", "vencimento"]) ?? "",
        diasAtraso: pickNum(t, ["diasAtraso"]),
        status,
        pago: status ? PAGO.test(status) : (pickNum(t, ["statusid"]) === 2),
        cancelado: status ? CANCELADO.test(status) : false,
        linhaDigitavel: pickStr(t, ["linhaDigitavel", "linhadigitavel"]),
        codigoBarras: pickStr(t, ["codigoBarras", "codigobarras"]),
        codigoPix: pickStr(t, ["codigoPix", "codigopix"]),
        link: pickStr(t, ["link"]),
        linkCobranca: pickStr(t, ["link_cobranca", "linkCobranca"]),
      };
    });
}

export function normalizeSegundaVia(raw: Record<string, unknown>): SgpSegundaVia {
  const links = asArray(raw.links);
  return {
    ok: (pickNum(raw, ["status"]) ?? 0) === 1 || links.length > 0,
    protocolo: pickStr(raw, ["protocolo"]),
    mensagem: pickStr(raw, ["msg", "mensagem"]),
    contrato: pickNum(raw, ["contratoId", "contrato"]),
    faturas: links.map((l) => ({
      fatura: pickNum(l, ["fatura", "id"]) ?? 0,
      valor: pickNum(l, ["valor"]) ?? 0,
      vencimento: pickStr(l, ["vencimento"]) ?? "",
      linhaDigitavel: pickStr(l, ["linhadigitavel", "linhaDigitavel"]),
      codigoPix: pickStr(l, ["codigopix", "codigoPix"]),
      link: pickStr(l, ["link"]),
      linkCobranca: pickStr(l, ["link_cobranca", "linkCobranca"]),
    })),
    raw,
  };
}

function normalizeAcao(raw: Record<string, unknown>): SgpAcaoResult {
  const status = pickNum(raw, ["status"]);
  const ok = status != null ? status === 1 : (pickBool(raw, ["sucesso", "ok"]) ?? !pick(raw, ["erro", "error"]));
  return {
    ok: !!ok,
    protocolo: pickStr(raw, ["protocolo", "os_protocolo"]),
    mensagem: pickStr(raw, ["msg", "mensagem", "detalhe", "erro"]),
    contrato: pickNum(raw, ["contratoId", "contrato", "contrato_id"]),
    raw,
  };
}
