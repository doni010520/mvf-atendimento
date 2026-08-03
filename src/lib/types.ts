export type Role = "admin" | "supervisor" | "agent";
export type ChannelType = "meta_cloud" | "uazapi";
export type ChannelStatus = "pending" | "connecting" | "connected" | "disconnected" | "error";
export type ConversationStatus = "bot" | "queued" | "open" | "closed";
export type MessageDirection = "in" | "out";
export type SenderType = "contact" | "agent" | "bot" | "system";
export type ContentType =
  | "text" | "image" | "audio" | "video" | "document"
  | "location" | "contact" | "template" | "sticker";

export type AutoMessageEvent = "welcome" | "away" | "out_of_hours" | "close" | "queue_wait" | "agent_assign";

export interface Organization {
  id: string;
  name: string;
  document: string | null;
  settings: OrgSettings;
  created_at: string;
}

/** Configurações da organização (organizations.settings JSONB). */
export interface OrgSettings {
  // --- Geral ---
  identify_agent?: boolean;
  close_command?: string;              // palavra-chave do cliente p/ encerrar
  close_command_message?: string;
  allow_agent_reconnect?: boolean;
  timezone_offset?: number;            // offset UTC (default -3)
  ip_whitelist?: string[];
  // --- Atendimento ---
  auto_close_company_min?: number;     // encerrar se empresa não interagir
  auto_close_client_min?: number;
  auto_close_queue?: boolean;
  auto_close_by_dept?: Record<string, number>;
  auto_transfer_dept_id?: string;
  auto_transfer_company_min?: number;
  auto_transfer_client_min?: number;
  // Encerramento por inatividade (avisa, depois despede + fecha + reinicia o fluxo)
  inactivity_enabled?: boolean;
  inactivity_warn_min?: number;
  inactivity_close_min?: number;
  inactivity_warn_message?: string;
  inactivity_goodbye_message?: string;
  require_classification?: "never" | "always" | "company" | "client";
  require_close_reason?: boolean;
  csat_policy?: "optional_on" | "optional_off" | "always" | "admin_only";
  csat_select_survey?: boolean;
  search_mode?: "none" | "own" | "all";
  transfer_idle?: "none" | "manual" | "automation" | "both";
  distribute_least_loaded?: boolean;
  auto_send_assign_msg?: boolean;
  transfer_online_only?: boolean;
  away_msg_interval_min?: number;
  hide_msgs_mode?: "none" | "queue" | "queue_automation";
  allow_company_start?: boolean;
  show_tags_on_card?: boolean;
  read_confirmation?: boolean;
  block_return_to_bot?: boolean;
  close_no_msg_for_agents?: boolean;
  follow_me_channel_id?: string;
  // --- Chat V2 ---
  v2_order_by?: "last_message" | "transfer_date";
  v2_block_unassigned?: boolean;
  v2_auto_transcribe?: boolean;
  v2_use_address?: boolean;
  v2_recurrence_enabled?: boolean;
  v2_recurrence_days?: number;
  v2_recurrence_low?: number;
  v2_recurrence_medium?: number;
  v2_recurrence_high?: number;
  v2_open_erp_on_close?: "none" | "optional" | "required";
  v2_queue_alert_count?: number;
  v2_queue_alert_min?: number;
  v2_queue_alert_popup?: boolean;
  v2_queue_alert_sound?: boolean;
  v2_queue_msg_enabled?: boolean;
  v2_queue_msg_text?: string;
  v2_queue_msg_interval_min?: number;
  v2_show_only_internet?: boolean;
  v2_show_cancelled?: boolean;
  v2_show_titles?: boolean;
  v2_promise_global?: boolean;
  v2_promise_days?: number;
  v2_search_all_boletos?: boolean;
  v2_show_nonstandard_boletos?: boolean;
  v2_boleto_days?: number;
  v2_only_overdue_plus_next?: boolean;
  v2_use_billing_link?: boolean;
  v2_sidebar_collapsed?: boolean;
  v2_show_channel_on_card?: boolean;
  v2_color_no_interaction?: boolean;
  v2_color_client_normal_sec?: number;
  v2_color_client_normal?: string;
  v2_color_client_medium_sec?: number;
  v2_color_client_medium?: string;
  v2_color_client_high_sec?: number;
  v2_color_client_high?: string;
  v2_color_agent_enabled?: boolean;
  v2_color_agent_sec?: number;
  v2_color_agent_color?: string;
  v2_notify_high?: boolean;
  // --- Permissões ---
  v2_mask_cpf?: boolean;
  v2_only_v2?: boolean;
  v2_agent_see_closed?: boolean;
  v2_hide_dashboard_agents?: boolean;
  v2_agent_close_queue?: boolean;
  v2_agent_bulk_close?: boolean;
  v2_agent_manage_clients?: boolean;
  v2_hide_contact_agents?: boolean;
  // catch-all
  [key: string]: unknown;
}

export interface Profile {
  id: string;
  organization_id: string | null;
  name: string;
  email: string | null;
  role: Role;
  department_id: string | null;
  avatar_url: string | null;
  status: "online" | "away" | "offline";
  whatsapp: string | null;
  notify: boolean;
  totp_enabled?: boolean;
  created_at: string;
}

export interface Department {
  id: string;
  organization_id: string;
  name: string;
  color: string | null;
  created_at: string;
}

export type TagScope = "conversation" | "contact" | "status";

export interface Tag {
  id: string;
  organization_id: string;
  name: string;
  color: string | null;
  scope: TagScope;
  created_at: string;
}

export interface QuickReply {
  id: string;
  organization_id: string;
  title: string;
  content: string;
  shortcut: string | null;
  kind: "model" | "macro" | "auto";
  created_at: string;
}

/** Horário de execução: chaves sun/mon/.../sat, valor = array de faixas [HH:MM, HH:MM]. */
export type AutomationSchedule = Partial<Record<"sun"|"mon"|"tue"|"wed"|"thu"|"fri"|"sat", [string, string][]>>;

export interface Automation {
  id: string;
  organization_id: string;
  channel_id: string | null;
  /** SGP vinculado. Se null, usa o primeiro SGP da organização. */
  integration_id: string | null;
  name: string;
  trigger: string | null;
  flow: { nodes: unknown[]; edges: unknown[] };
  /** Restrição de horário. null = sem restrição (roda 24/7). */
  schedule: AutomationSchedule | null;
  active: boolean;
  updated_at: string;
  created_at: string;
}

export interface Integration {
  id: string;
  organization_id: string;
  type: string;
  config: Record<string, unknown>;
  active: boolean;
  created_at: string;
}

export interface AiAgentConfigJson {
  temperature?: number;
  tone?: string;
  agent_name?: string;
  knowledge?: string;
  base_prompt?: string;
  /** Se true (padrão), o agente só responde a números da allowlist. */
  restrict_to_allowlist?: boolean;
}

export interface AiAllowedNumber {
  id: string;
  organization_id: string;
  phone: string;
  label: string | null;
  active: boolean;
  created_at: string;
}

export interface AiAgent {
  id: string;
  organization_id: string;
  channel_id: string | null;
  name: string;
  prompt: string | null;
  model: string | null;
  config: AiAgentConfigJson;
  active: boolean;
  created_at: string;
}

export type CampaignStatus = "draft" | "scheduled" | "running" | "paused" | "done" | "failed";

export interface Campaign {
  id: string;
  organization_id: string;
  automation_id: string | null;
  channel_id: string | null;
  name: string;
  message: string | null;
  status: CampaignStatus;
  audience: unknown[];
  contact_filter: Record<string, unknown>;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  progress: number;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  stats: Record<string, unknown>;
  created_at: string;
}

export interface Plan {
  id: string;
  organization_id: string;
  name: string;
  price: number | null;
  description: string | null;
  created_at: string;
}

export interface Channel {
  id: string;
  organization_id: string;
  name: string;
  type: ChannelType;
  phone: string | null;
  status: ChannelStatus;
  external_id: string | null;
  credentials: Record<string, unknown>;
  created_at: string;
}

export interface Contact {
  id: string;
  organization_id: string;
  name: string | null;
  phone: string;
  avatar_url: string | null;
  email?: string | null;
  birthday?: string | null;
  city?: string | null;
  address?: string | null;
  custom_fields: Record<string, unknown>;
  notes: string | null;
  is_group?: boolean;
  created_at: string;
}

export interface Conversation {
  id: string;
  organization_id: string;
  channel_id: string;
  contact_id: string;
  status: ConversationStatus;
  assigned_user_id: string | null;
  department_id: string | null;
  protocol: string | null;
  last_message_at: string | null;
  opened_at: string | null;
  closed_at: string | null;
  satisfaction: number | null;
  close_reason: string | null;
  survey_id: string | null;
  awaiting_satisfaction: boolean;
  is_muted?: boolean;
  pinned?: boolean;
  archived?: boolean;
  created_at: string;
}

export interface ConversationOverview {
  id: string;
  organization_id: string;
  status: ConversationStatus;
  assigned_user_id: string | null;
  offered_to?: string[] | null;
  department_id: string | null;
  channel_id: string;
  contact_id: string;
  protocol: string | null;
  last_message_at: string | null;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  contact_name: string | null;
  contact_phone: string;
  contact_avatar: string | null;
  contact_email?: string | null;
  contact_city?: string | null;
  channel_name: string;
  channel_type: ChannelType;
  last_message_body: string | null;
  last_message_type: ContentType | null;
  last_message_direction: MessageDirection | null;
  last_message_author?: string | null;
  last_message_created_at?: string | null;
  is_group?: boolean;
  is_muted?: boolean;
  pinned?: boolean;
  archived?: boolean;
  contact_jid?: string | null;
  unread_count?: number;
  satisfaction?: number | null;
  close_reason?: string | null;
  bot_automation_id?: string | null;
  ai_enabled?: boolean;
  assigned_name?: string | null;
  department_name?: string | null;
  department_color?: string | null;
  survey_id?: string | null;
  awaiting_satisfaction?: boolean;
  closed_by?: string | null;
}

export interface Message {
  id: string;
  organization_id: string;
  conversation_id: string;
  direction: MessageDirection;
  sender_type: SenderType;
  sender_id: string | null;
  content_type: ContentType;
  body: string | null;
  media_url: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  external_id: string | null;
  author_name?: string | null;
  author_phone?: string | null;
  author_lid?: string | null;
  reply_to_external?: string | null;
  reply_excerpt?: string | null;
  reply_author?: string | null;
  reactions?: { emoji: string; by: string }[];
  is_deleted?: boolean;
  deleted_scope?: "me" | "everyone" | null;
  edited?: boolean;
  is_internal?: boolean;
  forwarded?: boolean;
  mentions?: { id: string; name: string }[];
  created_at: string;
}

/** Notificação de menção interna (sino) para um atendente. */
export interface InternalMention {
  id: string;
  organization_id: string;
  conversation_id: string;
  message_id: string;
  mentioned_user_id: string;
  created_by: string | null;
  author_name: string | null;
  excerpt: string | null;
  contact_name: string | null;
  read_at: string | null;
  created_at: string;
}

export interface SatisfactionSurvey {
  id: string;
  organization_id: string;
  name: string;
  active: boolean;
  scale_type: "stars" | "buttons";
  scale_max: number;
  question: string;
  channels: string[];
  close_after_min: number;
  created_at: string;
}

export interface BusinessHour {
  id: string;
  organization_id: string;
  department_id: string | null;
  day_of_week: number;
  start_time: string;
  end_time: string;
  active: boolean;
}

export interface AutoMessage {
  id: string;
  organization_id: string;
  event: AutoMessageEvent;
  channel_id: string | null;
  department_id: string | null;
  body: string;
  active: boolean;
  interval_min: number | null;
  created_at: string;
}
