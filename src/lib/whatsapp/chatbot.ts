import type { createServiceClient } from "@/lib/supabase/server";
import { getProvider } from "./index";
import { getAiAgent, getAiAgentById, runAiTurn, isAiAllowed, type AiTurnResult } from "./ai";
import { sgpForOrg, sgpForIntegration } from "@/lib/sgp";
import type { Channel } from "@/lib/types";

type DB = ReturnType<typeof createServiceClient>;

/** Dados de um nó do fluxo (todos os campos opcionais conforme o tipo). */
interface FlowNodeData {
  kind?: string;
  label?: string;
  content?: string;
  // mídia
  mediaUrl?: string;
  mediaKind?: "image" | "audio" | "video" | "document";
  // menu
  options?: { id: string; label: string }[];
  // condição
  keywords?: string;
  // transferir
  departmentId?: string;
  // agente de IA
  agentId?: string;
  // aguardar
  mode?: "reply" | "delay";
  seconds?: number;
  // coletar resposta
  variable?: string;
  // ação SGP
  action?: "segunda_via" | "pix" | "status" | "liberacao" | "faturas";
  // tag
  tagId?: string;
}
interface FlowNode {
  id: string;
  data?: FlowNodeData;
}
interface FlowEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
}
interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface ConvState {
  id: string;
  organization_id: string;
  channel_id: string;
  contact_phone: string;
  contact_name?: string | null;
  is_group: boolean;
  bot_node_id: string | null;
}

const node = (f: Flow, id: string) => f.nodes.find((n) => n.id === id);
/** Aresta de saída: por handle específico, ou a primeira disponível. */
const outBy = (f: Flow, id: string, handle?: string) =>
  handle != null
    ? f.edges.find((e) => e.source === id && (e.sourceHandle ?? null) === handle)
    : f.edges.find((e) => e.source === id);
const outAll = (f: Flow, id: string) => f.edges.filter((e) => e.source === id);
const startNode = (f: Flow) => f.nodes.find((n) => n.data?.kind === "start") ?? f.nodes.find((n) => n.id === "start");
const kindOf = (n?: FlowNode) => n?.data?.kind ?? "message";

/** Substitui merge fields {{var}} pelo valor do contexto (vars + contato). */
function applyVars(text: string, vars: Record<string, unknown>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v == null ? "" : String(v);
  });
}

/**
 * Executa o fluxo de automação para uma conversa, a partir do estado salvo
 * (bot_node_id) e da última mensagem do contato. Suporta nós: message, menu,
 * condition, transfer, ai, wait, input (coletar variável), media, sgp, tag.
 * Roteamento por sourceHandle (ramos rotulados), merge fields e variáveis.
 *
 * Retorna o novo status sugerido: "bot" (pausado aguardando resposta),
 * "queued" (transferido p/ humano) ou null (sem mudança / ocioso).
 */
export async function runChatbot(
  db: DB,
  channel: Channel,
  conv: ConvState,
  automation: { id: string; flow: Flow; integration_id?: string | null },
  userText: string,
): Promise<"bot" | "queued" | null> {
  const flow: Flow = {
    nodes: Array.isArray(automation.flow?.nodes) ? automation.flow.nodes : [],
    edges: Array.isArray(automation.flow?.edges) ? automation.flow.edges : [],
  };
  if (!flow.nodes.length) return null;

  // Variáveis acumuladas da conversa (para coleta + merge fields).
  const { data: cvar } = await db.from("conversations").select("variables").eq("id", conv.id).maybeSingle();
  const vars: Record<string, unknown> = { ...((cvar?.variables as Record<string, unknown>) ?? {}) };
  const ctx = () => ({ nome: conv.contact_name ?? "", telefone: conv.contact_phone, ...vars });
  const persistVars = () => db.from("conversations").update({ variables: vars }).eq("id", conv.id);

  const provider = getProvider(channel);
  const to = conv.is_group && channel.type === "uazapi" ? `${conv.contact_phone}@g.us` : conv.contact_phone;

  const send = async (text: string) => {
    if (!text?.trim()) return;
    // Se o envio ao WhatsApp falhar, a resposta do bot é registrada como "failed"
    // (mesma semântica do envio humano) — nunca como "sent" enganoso.
    let externalId: string | undefined;
    let ok = true;
    // PIX copia-e-cola (EMV começa com "000201"): manda com BOTÃO DE COPIAR
    // quando o provedor suporta (uazapi) — o cliente toca e copia. Na Meta
    // oficial não há botão em msg livre, então cai no texto normal.
    const isPix = text.trim().startsWith("000201") && text.trim().length > 40;
    try {
      if (isPix && typeof provider.sendPixCopy === "function") {
        const res = await provider.sendPixCopy({
          to, text: "Toque no botão para copiar o código PIX 👇",
          buttonLabel: "Copiar código PIX", code: text.trim(),
        });
        externalId = res.externalId;
      } else {
        const res = await provider.sendText({ to, text });
        externalId = res.externalId;
      }
    } catch (e) {
      ok = false;
      console.error("chatbot send error", e);
    }
    await db.from("messages").insert({
      organization_id: conv.organization_id, conversation_id: conv.id,
      direction: "out", sender_type: "bot", content_type: "text",
      body: text, external_id: externalId ?? null, status: ok ? "sent" : "failed",
    });
  };
  /** Envia texto de nó com substituição de merge fields. */
  const sendMerged = (text?: string) => send(applyVars(text ?? "", ctx()));

  const sendMedia = async (url: string, kind: "image" | "audio" | "video" | "document", caption?: string) => {
    if (!url) return;
    const cap = caption ? applyVars(caption, ctx()) : undefined;
    let externalId: string | undefined;
    let ok = true;
    try {
      const res = await provider.sendMedia({ to, url, caption: cap, kind });
      externalId = res.externalId;
    } catch (e) {
      ok = false;
      console.error("chatbot sendMedia error", e);
    }
    await db.from("messages").insert({
      organization_id: conv.organization_id, conversation_id: conv.id,
      direction: "out", sender_type: "bot", content_type: kind,
      body: cap ?? null, media_url: url, external_id: externalId ?? null, status: ok ? "sent" : "failed",
    });
  };

  /** Resposta da IA em áudio (TTS): sobe no storage e manda como voz. */
  const sendAudio = async (audio: { buffer: Buffer; mime: string }, transcript: string) => {
    try {
      const path = `${conv.organization_id}/bot/${conv.id}-${Math.random().toString(36).slice(2)}.ogg`;
      const up = await db.storage.from("media").upload(path, audio.buffer, { contentType: audio.mime, upsert: true });
      if (up.error) throw up.error;
      const url = db.storage.from("media").getPublicUrl(path).data.publicUrl;
      let externalId: string | undefined;
      let ok = true;
      try {
        const res = await provider.sendMedia({ to, url, kind: "audio" });
        externalId = res.externalId;
      } catch (e) {
        ok = false;
        console.error("chatbot sendAudio error", e);
      }
      await db.from("messages").insert({
        organization_id: conv.organization_id, conversation_id: conv.id,
        direction: "out", sender_type: "bot", content_type: "audio",
        body: transcript, media_url: url, external_id: externalId ?? null, status: ok ? "sent" : "failed",
      });
    } catch {
      await send(transcript);
    }
  };

  /** Nó de IA: roda um turno do agente (específico do nó ou o ativo da org). */
  const aiNode = async (n: FlowNode): Promise<"bot" | "queued" | null | "next"> => {
    const agent = n.data?.agentId
      ? (await getAiAgentById(db, n.data.agentId)) ?? (await getAiAgent(db, conv.organization_id, conv.channel_id))
      : await getAiAgent(db, conv.organization_id, conv.channel_id);
    if (!agent) {
      await sendMerged(n.data?.content ?? "");
      return "next";
    }
    if (agent.restrictToAllowlist && !(await isAiAllowed(db, conv.organization_id, conv.contact_phone))) {
      await clearState(db, conv.id);
      return "queued";
    }
    const result = await runAiTurn({
      db, organizationId: conv.organization_id, integrationId: automation.integration_id,
      conversationId: conv.id, contactPhone: conv.contact_phone, contactName: conv.contact_name,
      agent, nodeInstruction: n.data?.content, userText,
      sendToCustomer: send, sendAudioToCustomer: sendAudio,
    });
    if (result.decision === "transfer") {
      await routeTransfer(db, conv.organization_id, conv.id, result.transfer);
      await clearState(db, conv.id);
      return "queued";
    }
    if (result.decision === "wait") {
      await saveState(db, conv.id, automation.id, n.id);
      return "bot";
    }
    if (result.decision === "done") {
      // IA finalizou o atendimento (problema resolvido): a própria IA já se
      // despediu na última mensagem. Encerra e reseta — a próxima mensagem do
      // cliente recomeça o fluxo do zero (conversa fechada não é reaproveitada).
      await db.from("conversations")
        .update({ status: "closed", closed_at: new Date().toISOString(), bot_node_id: null, inactivity_warned_at: null })
        .eq("id", conv.id);
      return null;
    }
    if (outBy(flow, n.id)) return "next";
    await clearState(db, conv.id);
    return null;
  };

  /** Executa um nó de ação SGP de forma determinística e envia o resultado. */
  const sgpNode = async (n: FlowNode) => {
    const sgp = automation.integration_id
      ? await sgpForIntegration(db, automation.integration_id).catch(() => null)
      : await sgpForOrg(db, conv.organization_id).catch(() => null);
    if (!sgp) { await send("Não foi possível consultar o sistema agora."); return; }
    const contrato = Number(vars.contrato) || undefined;
    const cpfcnpj = vars.cpfcnpj ? String(vars.cpfcnpj) : undefined;
    try {
      switch (n.data?.action) {
        case "segunda_via": {
          const r = await sgp.segundaVia({ contrato, cpfcnpj });
          if (!r.ok || !r.faturas.length) { await send(r.mensagem ?? "Nenhuma fatura encontrada."); break; }
          for (const f of r.faturas) {
            await send(`Fatura ${f.fatura} — R$ ${f.valor?.toFixed(2)} (venc. ${f.vencimento})`);
            if (f.linhaDigitavel) await send(f.linhaDigitavel);
            if (f.link) await send(f.link);
          }
          break;
        }
        case "faturas": {
          const t = await sgp.titulosEmAberto({ contrato, cpfcnpj });
          await send(t.length ? t.map((f) => `Fatura ${f.fatura}: R$ ${f.valor?.toFixed(2)} (venc. ${f.vencimento})`).join("\n") : "Nenhuma fatura em aberto.");
          break;
        }
        case "pix": {
          const t = await sgp.titulosEmAberto({ contrato, cpfcnpj });
          if (!t.length) { await send("Nenhuma fatura em aberto para gerar PIX."); break; }
          const px = await sgp.gerarPix(t[0].fatura, contrato);
          await send(px.codigoPix ? px.codigoPix : "PIX indisponível para esta fatura.");
          break;
        }
        case "status": {
          const r = await sgp.statusConexao({ contrato });
          await send(r.online ? "Sua conexão está ONLINE. ✅" : `Sua conexão está OFFLINE.${r.mensagem ? ` ${r.mensagem}` : ""}`);
          break;
        }
        case "liberacao": {
          if (!contrato) { await send("Preciso identificar seu contrato antes de liberar."); break; }
          const r = await sgp.liberacaoConfianca({ contrato });
          await send(r.ok ? `Liberação efetuada! Protocolo: ${r.protocolo ?? "—"}` : (r.mensagem ?? "Não foi possível liberar."));
          break;
        }
        default:
          await send("Ação não reconhecida.");
      }
    } catch {
      await send("Tive um problema ao consultar o sistema. Vou te encaminhar para um atendente.");
    }
  };

  // ── Descobre o nó atual (início ou retomada de um nó pausado) ──
  let currentId: string | null;
  if (!conv.bot_node_id) {
    const start = startNode(flow);
    currentId = start ? outBy(flow, start.id)?.target ?? null : null;
  } else {
    const cur = node(flow, conv.bot_node_id);
    const k = kindOf(cur);
    if (k === "ai" && cur) {
      const r = await aiNode(cur);
      if (r !== "next") return r;
      currentId = outBy(flow, cur.id)?.target ?? null;
    } else if (k === "menu" && cur) {
      // Casa a resposta do cliente com uma opção do menu → ramo daquela opção.
      const txt = userText.trim().toLowerCase();
      const opts = cur.data?.options ?? [];
      let handle: string | undefined;
      const num = parseInt(txt, 10);
      if (!Number.isNaN(num) && opts[num - 1]) handle = opts[num - 1].id;
      else handle = opts.find((o) => o.label.toLowerCase().includes(txt) && txt.length > 0)?.id;
      const edge = handle ? outBy(flow, cur.id, handle) : undefined;
      // Fallback legado: roteia por ordem das arestas se não houver options/handles.
      const legacy = !opts.length ? (!Number.isNaN(num) ? outAll(flow, cur.id)[num - 1] : undefined) : undefined;
      const chosen = edge ?? legacy;
      if (!chosen) { await send("Opção inválida. Responda com o número da opção desejada."); return "bot"; }
      currentId = chosen.target;
    } else if (k === "input" && cur) {
      // Captura a resposta na variável e segue.
      if (cur.data?.variable) { vars[cur.data.variable] = userText.trim(); await persistVars(); }
      currentId = outBy(flow, cur.id)?.target ?? null;
    } else if (k === "wait" && cur) {
      currentId = outBy(flow, cur.id)?.target ?? null;
    } else {
      // Condição/legado: avalia pela última mensagem.
      const keys = (cur?.data?.keywords ?? cur?.data?.content ?? "").toLowerCase().split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      const match = keys.some((kw) => userText.toLowerCase().includes(kw));
      currentId = (outBy(flow, conv.bot_node_id, match ? "true" : "false") ?? outAll(flow, conv.bot_node_id)[match ? 0 : 1] ?? outAll(flow, conv.bot_node_id)[0])?.target ?? null;
    }
  }

  // ── Caminha pelos nós até pausar (menu/input/wait-reply), transferir ou terminar ──
  let guard = 0;
  while (currentId && guard++ < 30) {
    const n = node(flow, currentId);
    if (!n) break;
    const k = kindOf(n);

    if (k === "ai") {
      const r = await aiNode(n);
      if (r !== "next") return r;
      currentId = outBy(flow, n.id)?.target ?? null;
      continue;
    }
    if (k === "message") {
      await sendMerged(n.data?.content);
      if (n.data?.mediaUrl) await sendMedia(n.data.mediaUrl, n.data.mediaKind ?? "document", undefined);
      const next = outBy(flow, n.id);
      if (!next) { await clearState(db, conv.id); return "queued"; }
      currentId = next.target;
      continue;
    }
    if (k === "media") {
      if (n.data?.mediaUrl) await sendMedia(n.data.mediaUrl, n.data.mediaKind ?? "document", n.data.content);
      currentId = outBy(flow, n.id)?.target ?? null;
      if (!currentId) { await clearState(db, conv.id); return "queued"; }
      continue;
    }
    if (k === "menu") {
      await sendMerged(n.data?.content);
      await saveState(db, conv.id, automation.id, n.id);
      return "bot";
    }
    if (k === "input") {
      await sendMerged(n.data?.content);
      await saveState(db, conv.id, automation.id, n.id);
      return "bot";
    }
    if (k === "condition") {
      const keys = (n.data?.keywords ?? n.data?.content ?? "").toLowerCase().split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      const match = keys.some((kw) => userText.toLowerCase().includes(kw));
      currentId = (outBy(flow, n.id, match ? "true" : "false") ?? outAll(flow, n.id)[match ? 0 : 1] ?? outAll(flow, n.id)[0])?.target ?? null;
      continue;
    }
    if (k === "sgp") {
      await sgpNode(n);
      currentId = outBy(flow, n.id)?.target ?? null;
      if (!currentId) { await clearState(db, conv.id); return "queued"; }
      continue;
    }
    if (k === "tag") {
      if (n.data?.tagId) {
        await db.from("conversation_tags").upsert(
          { conversation_id: conv.id, tag_id: n.data.tagId },
          { onConflict: "conversation_id,tag_id", ignoreDuplicates: true },
        ).select().maybeSingle().then(() => {}, () => {});
      }
      currentId = outBy(flow, n.id)?.target ?? null;
      if (!currentId) { await clearState(db, conv.id); return "queued"; }
      continue;
    }
    if (k === "transfer") {
      await sendMerged(n.data?.content);
      await db.from("conversations").update({
        status: "queued",
        ...(n.data?.departmentId ? { department_id: n.data.departmentId } : {}),
      }).eq("id", conv.id);
      await clearState(db, conv.id);
      return "queued";
    }
    if (k === "wait") {
      if (n.data?.mode === "reply") {
        await saveState(db, conv.id, automation.id, n.id);
        return "bot";
      }
      // modo "delay": sem agendador em runtime serverless → segue adiante.
      currentId = outBy(flow, n.id)?.target ?? null;
      continue;
    }
    break;
  }
  await clearState(db, conv.id);
  return "queued";
}

/**
 * Roteia a transferência da IA para um departamento no formato SETOR/CIDADE
 * (ex.: FINANCEIRO/IGUAI) e registra uma nota interna. Atribui ao POOL (department).
 */
async function routeTransfer(db: DB, orgId: string, convId: string, transfer: AiTurnResult["transfer"]) {
  const setor = transfer?.setor;
  const cidade = transfer?.cidade?.trim();
  let deptName: string | undefined;
  let deptId: string | null = null;

  if (setor) {
    const { data: depts } = await db.from("departments").select("id, name").eq("organization_id", orgId);
    const list = (depts ?? []) as { id: string; name: string }[];
    const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
    const setorN = norm(setor);
    const cidadeN = cidade ? norm(cidade) : "";
    const match =
      (cidadeN && list.find((d) => norm(d.name).includes(setorN) && norm(d.name).includes(cidadeN))) ||
      list.find((d) => norm(d.name).includes(setorN));
    if (match) { deptId = match.id; deptName = match.name; }
  }

  await db.from("conversations").update({ status: "queued", ...(deptId ? { department_id: deptId } : {}) }).eq("id", convId);

  const destino = deptName ?? ([setor?.toUpperCase(), cidade?.toUpperCase()].filter(Boolean).join("/") || "fila geral");
  const motivo = transfer?.motivo ? ` — ${transfer.motivo}` : "";
  await db.from("messages").insert({
    organization_id: orgId, conversation_id: convId,
    direction: "out", sender_type: "system", content_type: "text",
    body: `Atendimento transferido pela automação para *${destino}*${motivo}.`,
    is_internal: true, status: "sent",
  });
}

async function saveState(db: DB, convId: string, automationId: string, nodeId: string) {
  await db.from("conversations").update({ bot_automation_id: automationId, bot_node_id: nodeId, status: "bot" }).eq("id", convId);
}
async function clearState(db: DB, convId: string) {
  await db.from("conversations").update({ bot_node_id: null }).eq("id", convId);
}
