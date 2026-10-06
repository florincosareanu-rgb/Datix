// Tipuri și constante comune între server și aplicația web (PWA).
// Tot ce circulă prin API are forma descrisă aici.

export * from './labels';

// ---------------------------------------------------------------------------
// Generale
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Contextul în care rulează agentul. Determină uneltele disponibile și regulile de autonomie. */
export type AgentContext = 'owner' | 'incident' | 'ticket' | 'report' | 'mission';

/**
 * Nivelul de risc al unei unelte:
 * - read: doar citește
 * - write: modificare reversibilă (cu backup automat sau ușor de anulat)
 * - irreversible: greu sau imposibil de anulat (restaurare backup, DNS, actualizări, suspendări)
 * - customer_message: trimite un mesaj către un client
 */
export type RiskLevel = 'read' | 'write' | 'irreversible' | 'customer_message';

// ---------------------------------------------------------------------------
// Monitorizare
// ---------------------------------------------------------------------------

export type MonitorStatus = 'up' | 'down' | 'degraded' | 'unknown' | 'paused';

export type MonitorKind =
  | 'http'
  | 'tls'
  | 'domain'
  | 'dns'
  | 'blacklist'
  | 'pagespeed'
  | 'security_scan'
  | 'wp_health'
  | 'wp_vulns'
  | 'whmcs_health'
  | 'da_usage'
  | 'business'
  | 'tickets_poll'
  | 'cloudflare_security'
  | 'reseller_accounts'
  | 'backup'
  | 'wp_integrity'
  | 'email_delivery'
  | 'efactura';

export interface MonitorDTO {
  id: string;
  kind: MonitorKind;
  name: string;
  target: string;
  intervalSec: number;
  enabled: boolean;
  status: MonitorStatus;
  lastCheckAt: number | null;
  lastChangeAt: number | null;
  lastMessage: string | null;
  lastLatencyMs: number | null;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  /** ultimele valori de latență (ms), cele mai vechi primele, pentru grafic */
  latencySeries: Array<{ at: number; ms: number | null; status: MonitorStatus }>;
}

export interface CheckResultDTO {
  at: number;
  status: MonitorStatus;
  latencyMs: number | null;
  message: string | null;
}

// ---------------------------------------------------------------------------
// Incidente
// ---------------------------------------------------------------------------

export type IncidentStatus = 'open' | 'investigating' | 'mitigated' | 'resolved';

export interface IncidentDTO {
  id: string;
  monitorId: string | null;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  openedAt: number;
  resolvedAt: number | null;
  summary: string | null;
  rootCause: string | null;
  postmortem: string | null;
  conversationId: string | null;
  durationSec: number | null;
}

export interface IncidentEventDTO {
  id: number;
  at: number;
  kind: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Securitate
// ---------------------------------------------------------------------------

export type FindingStatus = 'open' | 'resolved' | 'ignored';

export interface FindingDTO {
  id: string;
  source: string;
  severity: Severity;
  title: string;
  details: string | null;
  recommendation: string | null;
  status: FindingStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
}

// ---------------------------------------------------------------------------
// Tichete
// ---------------------------------------------------------------------------

export type TicketMode = 'off' | 'draft' | 'auto';
export const TICKET_MODES: TicketMode[] = ['off', 'draft', 'auto'];

export type TicketJobStatus =
  | 'queued'
  | 'analyzing'
  | 'draft_ready'
  | 'sent'
  | 'escalated'
  | 'skipped'
  | 'discarded'
  | 'error';

export type EscalationReason = 'money' | 'cancellation' | 'account_change' | 'complaint_legal' | 'low_confidence' | 'auto_reply_limit' | 'other';

export interface TicketJobDTO {
  id: string;
  ticketId: number;
  tid: string | null;
  subject: string | null;
  clientName: string | null;
  clientEmail: string | null;
  department: string | null;
  status: TicketJobStatus;
  mode: TicketMode | null;
  category: string | null;
  urgency: string | null;
  sentiment: string | null;
  escalationReasons: EscalationReason[];
  summary: string | null;
  analysis: string | null;
  draft: string | null;
  finalMessage: string | null;
  confidence: number | null;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  error: string | null;
}

export interface TicketMessageDTO {
  id: string;
  author: string;
  isStaff: boolean;
  date: string;
  message: string;
}

export interface TicketDetailDTO {
  job: TicketJobDTO;
  thread: TicketMessageDTO[];
  whmcsUrl: string | null;
}

// ---------------------------------------------------------------------------
// Chat / agent
// ---------------------------------------------------------------------------

export interface ConversationDTO {
  id: string;
  title: string;
  kind: 'chat' | 'incident' | 'ticket' | 'report' | 'mission';
  refId: string | null;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
}

export interface ToolCallDTO {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error' | 'pending_approval' | 'rejected';
  resultPreview: string | null;
  approvalId: string | null;
}

export interface ChatMessageDTO {
  id: string;
  role: 'user' | 'assistant' | 'system_note';
  content: string;
  toolCalls: ToolCallDTO[];
  createdAt: number;
  /** pentru mesajele asistentului: dacă rularea s-a oprit cu eroare */
  error?: string | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'failed';

export interface ApprovalDTO {
  id: string;
  runId: string | null;
  conversationId: string | null;
  toolName: string;
  toolLabel: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  summary: string;
  status: ApprovalStatus;
  requiresStepUp: boolean;
  context: AgentContext;
  createdAt: number;
  decidedAt: number | null;
  result: string | null;
}

/** Evenimente trimise prin SSE în timpul unei rulări de chat. */
export type ChatStreamEvent =
  | { type: 'run_started'; runId: string; conversationId: string; messageId: string }
  | { type: 'text_delta'; messageId: string; delta: string }
  | { type: 'thinking'; messageId: string; active: boolean }
  | { type: 'tool_call'; messageId: string; call: ToolCallDTO }
  | { type: 'tool_result'; messageId: string; callId: string; status: ToolCallDTO['status']; resultPreview: string | null }
  | { type: 'approval_required'; approval: ApprovalDTO }
  | { type: 'message_done'; messageId: string }
  | { type: 'run_finished'; runId: string; status: 'done' | 'waiting_approval' | 'error' | 'cancelled'; error?: string }
  | { type: 'title'; conversationId: string; title: string };

/** Evenimente globale (dashboard live). */
export type ServerEvent =
  | { type: 'monitor'; monitor: MonitorDTO }
  | { type: 'incident'; incident: IncidentDTO }
  | { type: 'finding'; finding: FindingDTO }
  | { type: 'ticket_job'; job: TicketJobDTO }
  | { type: 'approval'; approval: ApprovalDTO }
  | { type: 'notification'; notification: NotificationDTO }
  | { type: 'chat'; conversationId: string; event: ChatStreamEvent }
  | { type: 'settings_changed' }
  | { type: 'mission'; mission: MissionDTO }
  | { type: 'collections_changed' }
  | { type: 'maintenance_changed'; area: 'backup' | 'updates' | 'email' | 'efactura' | 'seo' }
  | { type: 'ping'; at: number };

// ---------------------------------------------------------------------------
// Notificări, rapoarte, business, audit
// ---------------------------------------------------------------------------

export type NotificationKind = 'incident' | 'incident_resolved' | 'approval' | 'ticket' | 'security' | 'report' | 'system' | 'mission' | 'business' | 'maintenance';

export interface NotificationDTO {
  id: string;
  at: number;
  kind: NotificationKind;
  title: string;
  body: string;
  url: string | null;
  priority: 'low' | 'normal' | 'high' | 'critical';
  readAt: number | null;
}

export interface ReportDTO {
  id: string;
  kind: 'daily' | 'weekly' | 'incident';
  title: string;
  periodStart: number;
  periodEnd: number;
  createdAt: number;
  content: string;
}

export interface BusinessSnapshotDTO {
  at: number;
  currencyPrefix: string;
  currencySuffix: string;
  incomeToday: number | null;
  incomeThisMonth: number | null;
  incomeThisYear: number | null;
  ordersPending: number | null;
  ordersToday: number | null;
  ordersThisMonth: number | null;
  ticketsAwaitingReply: number | null;
  ticketsOpen: number | null;
  cancellationsPending: number | null;
  unpaidInvoices: number | null;
  unpaidTotal: number | null;
  overdueInvoices: number | null;
  activeServices: number | null;
  domainsExpiringSoon: number | null;
}

export interface BusinessDTO {
  latest: BusinessSnapshotDTO | null;
  timeline: Array<{ date: string; income: number; newOrders: number; newTickets: number }>;
  available: boolean;
  message: string | null;
}

export interface AuditEntryDTO {
  id: number;
  at: number;
  actor: 'owner' | 'agent' | 'system';
  context: string | null;
  action: string;
  target: string | null;
  details: string | null;
  result: string | null;
}

export interface UsageSummaryDTO {
  monthCostUsd: number;
  monthBudgetUsd: number;
  monthRequests: number;
  monthPromptTokens: number;
  monthCacheHitTokens: number;
  monthCompletionTokens: number;
  todayCostUsd: number;
  budgetExceeded: boolean;
}

// ---------------------------------------------------------------------------
// Setări
// ---------------------------------------------------------------------------

export interface SecretStatus {
  configured: boolean;
  hint: string | null;
}

export interface IntegrationStatusDTO {
  key: IntegrationKey;
  enabled: boolean;
  configured: boolean;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

export type IntegrationKey = 'llm' | 'whmcs' | 'directadmin' | 'reseller' | 'cloudflare' | 'wordpress' | 'pagespeed' | 'storage' | 'mailbox' | 'anaf' | 'gsc';

export interface AppSettings {
  general: {
    agentName: string;
    companyName: string;
    ownerName: string;
    timezone: string;
    appUrl: string;
  };
  llm: {
    baseUrl: string;
    model: string;
    incidentModel: string;
    thinking: boolean;
    reasoningEffort: 'low' | 'high' | 'max';
    monthlyBudgetUsd: number;
    hardStopAtBudget: boolean;
    maxStepsPerRun: number;
    priceInputPerM: number;
    priceCacheHitPerM: number;
    priceOutputPerM: number;
  };
  sites: {
    wordpressUrl: string;
    whmcsUrl: string;
    wordpressKeyword: string;
    whmcsKeyword: string;
    originIp: string;
    extraUrls: string[];
  };
  integrations: {
    whmcs: { enabled: boolean; url: string; replyAsAdmin: string };
    directadmin: { enabled: boolean; url: string; username: string; wordpressPath: string; whmcsPath: string };
    reseller: { enabled: boolean; url: string; username: string };
    cloudflare: { enabled: boolean; zoneName: string; zoneId: string };
    wordpress: { enabled: boolean; url: string };
    pagespeed: { enabled: boolean };
  };
  monitoring: {
    uptimeIntervalSec: number;
    failuresBeforeIncident: number;
    successesBeforeResolve: number;
    slowThresholdMs: number;
    autoInvestigate: boolean;
    escalateAfterMin: number;
    dnsResolvers: string[];
  };
  autonomy: {
    /** în chat cu tine: cere confirmare (Face ID) pentru acțiunile ireversibile */
    ownerConfirmIrreversible: boolean;
    /** la incidente: agentul aplică singur remedieri reversibile */
    incidentAutoRemediate: boolean;
    /** la incidente: agentul poate face și acțiuni ireversibile fără aprobare (nerecomandat) */
    incidentAllowIrreversible: boolean;
  };
  tickets: {
    mode: TicketMode;
    autoOnlyInSchedule: boolean;
    schedule: { weekdayStart: string; weekdayEnd: string; weekendsAllDay: boolean };
    escalate: { money: boolean; cancellation: boolean; accountChange: boolean; complaintLegal: boolean };
    minConfidence: number;
    maxAutoRepliesPerTicketPerDay: number;
    signature: string;
    aiNote: string;
    addInternalNote: boolean;
    pollIntervalSec: number;
    excludedDepartments: string[];
  };
  notifications: {
    incidents: boolean;
    approvals: boolean;
    tickets: boolean;
    security: boolean;
    dailyReport: boolean;
    /** încasări, clienți în risc, e-Factura, SEO */
    business: boolean;
    /** backup, actualizări, livrarea e-mailurilor */
    maintenance: boolean;
    vapidSubject: string;
  };
  reports: {
    dailyAt: string;
    dailyEnabled: boolean;
  };
  backups: {
    enabled: boolean;
    /** ora (HH:MM) la care pornește backup-ul zilnic */
    time: string;
    /** DAX cere singur un backup nou în DirectAdmin; altfel verifică doar ultimul existent */
    createNew: boolean;
    destination: 'local' | 's3';
    s3: { endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean };
    /** câte copii se păstrează în afara serverului */
    retain: number;
    /** câte backup-uri create de DAX rămân pe hosting (0 = nu șterge nimic de pe hosting) */
    keepOnServer: number;
    /** criptare AES-256 compatibilă cu OpenSSL, cu o parolă păstrată de tine */
    encrypt: boolean;
  };
  updates: {
    mode: 'off' | 'notify' | 'auto';
    time: string;
    plugins: boolean;
    themes: boolean;
    coreMinor: boolean;
    coreMajor: boolean;
    translations: boolean;
    /** pluginuri (fișierul principal) sau teme care nu se actualizează automat */
    exclude: string[];
    /** pagini verificate după fiecare actualizare, pe lângă prima pagină */
    checkUrls: string[];
    /** copie a bazei de date WordPress înainte de actualizări */
    dbSnapshot: boolean;
  };
  collections: {
    enabled: boolean;
    time: string;
    /** după câte zile de întârziere pregătește DAX o reamintire personală */
    overdueDays: number;
    /** după câte ore o comandă neplătită e considerată abandonată */
    pendingOrderHours: number;
    /** domeniile care expiră în atâtea zile */
    domainDays: number;
    /** după câte zile se poate pregăti o nouă reamintire pentru același lucru */
    repeatAfterDays: number;
  };
  churn: { enabled: boolean; weekday: number; time: string };
  integrity: { enabled: boolean };
  email: {
    enabled: boolean;
    /** căsuța folosită pentru test și pentru rapoartele DMARC */
    mailbox: string;
    imapHost: string;
    imapPort: number;
    testTime: string;
    /** clientul WHMCS de test (cu adresa căsuței), creat de DAX */
    whmcsTestClientId: number;
    dmarc: boolean;
  };
  efactura: { enabled: boolean; cif: string; environment: 'prod' | 'test'; clientId: string };
  seo: { enabled: boolean; property: string; weekday: number; time: string; keyPages: string[] };
}

export interface SettingsResponseDTO {
  settings: AppSettings;
  secrets: Record<string, SecretStatus>;
  integrations: IntegrationStatusDTO[];
  demoMode: boolean;
  version: string;
  vapidPublicKey: string | null;
}

export interface SessionInfoDTO {
  authenticated: boolean;
  setupRequired: boolean;
  setupTokenRequired: boolean;
  displayName: string | null;
  email: string | null;
  hasPasskey: boolean;
  totpEnabled: boolean;
  stepUpUntil: number;
  demoMode: boolean;
  agentName: string;
}

export interface StatusOverviewDTO {
  monitors: MonitorDTO[];
  openIncidents: IncidentDTO[];
  recentIncidents: IncidentDTO[];
  findingsBySeverity: Record<Severity, number>;
  pendingApprovals: number;
  ticketsNeedingAttention: number;
  usage: UsageSummaryDTO;
  integrations: IntegrationStatusDTO[];
  overall: 'ok' | 'degraded' | 'down' | 'unknown';
}

// ---------------------------------------------------------------------------
// Misiuni programate
// ---------------------------------------------------------------------------

export type MissionFrequency = 'once' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface MissionScheduleDTO {
  frequency: MissionFrequency;
  /** HH:MM (ora locală) — pentru daily / weekdays / weekly / monthly; minutul pentru hourly */
  time: string;
  /** 1 = luni … 7 = duminică (pentru weekly) */
  weekdays: number[];
  /** ziua din lună (1–28) pentru monthly */
  dayOfMonth: number;
  /** la câte ore (pentru hourly) */
  everyHours: number;
  /** momentul exact (ms) pentru once */
  runAt: number | null;
}

export interface MissionDTO {
  id: string;
  title: string;
  prompt: string;
  schedule: MissionScheduleDTO;
  scheduleText: string;
  allowChanges: boolean;
  enabled: boolean;
  createdBy: 'owner' | 'agent';
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | 'skipped' | null;
  lastSummary: string | null;
  lastConversationId: string | null;
  runCount: number;
  running: boolean;
}

// ---------------------------------------------------------------------------
// Încasări și clienți în risc
// ---------------------------------------------------------------------------

export type ReminderKind = 'invoice' | 'order' | 'domain';
export type ReminderStatus = 'draft' | 'sent' | 'dismissed' | 'failed' | 'resolved';

export interface ReminderDTO {
  id: string;
  kind: ReminderKind;
  refId: number;
  refLabel: string;
  clientId: number;
  clientName: string;
  clientEmail: string | null;
  amount: number | null;
  /** suma formatată, cu moneda („149,00 RON”) */
  amountText: string | null;
  dueDate: string | null;
  daysOverdue: number | null;
  subject: string;
  message: string;
  status: ReminderStatus;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  error: string | null;
}

export interface CollectionsDTO {
  available: boolean;
  message: string | null;
  generatedAt: number | null;
  currencyPrefix: string;
  currencySuffix: string;
  totals: { overdueInvoices: number; overdueAmount: number; pendingOrders: number; pendingAmount: number; expiringDomains: number };
  reminders: ReminderDTO[];
}

export interface ChurnSignalDTO {
  code: string;
  label: string;
  weight: number;
}

export interface ChurnClientDTO {
  clientId: number;
  name: string;
  company: string | null;
  email: string | null;
  score: number;
  level: 'high' | 'medium' | 'low';
  signals: ChurnSignalDTO[];
  suggestion: string | null;
  annualValue: number | null;
}

export interface ChurnReportDTO {
  available: boolean;
  message: string | null;
  generatedAt: number | null;
  currencyPrefix: string;
  currencySuffix: string;
  totals: { high: number; medium: number; valueAtRisk: number; analyzed: number };
  clients: ChurnClientDTO[];
}

// ---------------------------------------------------------------------------
// Mentenanță: backup, actualizări, e-mail
// ---------------------------------------------------------------------------

export type BackupRunStatus = 'running' | 'ok' | 'warning' | 'failed';

export interface BackupCheckDTO {
  label: string;
  ok: boolean;
  detail: string | null;
}

export interface BackupRunDTO {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: BackupRunStatus;
  trigger: string;
  file: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  destination: string | null;
  remoteKey: string | null;
  encrypted: boolean;
  checks: BackupCheckDTO[];
  log: string[];
  error: string | null;
}

export interface BackupOverviewDTO {
  configured: boolean;
  message: string | null;
  destinationLabel: string;
  running: boolean;
  nextRunAt: number | null;
  lastOk: BackupRunDTO | null;
  runs: BackupRunDTO[];
  stored: Array<{ key: string; sizeBytes: number; at: number }>;
}

export type UpdateItemResult = 'pending' | 'updated' | 'rolled_back' | 'failed' | 'skipped';

export interface UpdateItemDTO {
  type: 'plugin' | 'theme' | 'core' | 'translations';
  item: string;
  name: string;
  from: string | null;
  to: string | null;
  result: UpdateItemResult;
  message: string | null;
}

export interface UpdateRunDTO {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'ok' | 'rolled_back' | 'failed' | 'nothing' | 'notified';
  trigger: string;
  items: UpdateItemDTO[];
  log: string[];
  error: string | null;
}

export interface UpdatesOverviewDTO {
  available: boolean;
  message: string | null;
  running: boolean;
  nextRunAt: number | null;
  pending: Array<Pick<UpdateItemDTO, 'type' | 'item' | 'name' | 'from' | 'to'> & { excluded: boolean }>;
  runs: UpdateRunDTO[];
}

export interface EmailTestDTO {
  id: string;
  sentAt: number;
  receivedAt: number | null;
  status: 'waiting' | 'ok' | 'late' | 'missing' | 'error';
  latencySec: number | null;
  error: string | null;
}

export interface DmarcSourceDTO {
  ip: string;
  count: number;
  passed: number;
  failed: number;
  spf: string;
  dkim: string;
  disposition: string;
}

export interface DmarcSummaryDTO {
  periodStart: number;
  periodEnd: number;
  reports: number;
  messages: number;
  passed: number;
  failed: number;
  reporters: string[];
  sources: DmarcSourceDTO[];
}

export interface EmailOverviewDTO {
  configured: boolean;
  message: string | null;
  mailbox: string;
  whmcsTestReady: boolean;
  tests: EmailTestDTO[];
  dmarcRecord: string | null;
  dmarc: DmarcSummaryDTO | null;
  whmcsFailures24h: number;
}

// ---------------------------------------------------------------------------
// e-Factura (ANAF SPV)
// ---------------------------------------------------------------------------

export type EfacturaMessageType = 'sent' | 'received' | 'error' | 'buyer_message' | 'other';

export interface EfacturaMessageDTO {
  id: string;
  createdAt: number;
  type: EfacturaMessageType;
  uploadId: string | null;
  details: string;
  errors: string[];
  explanation: string | null;
}

export interface EfacturaOverviewDTO {
  configured: boolean;
  connected: boolean;
  message: string | null;
  cif: string;
  environment: 'prod' | 'test';
  redirectUri: string;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  lastCheckAt: number | null;
  counts7d: { sent: number; received: number; errors: number };
  messages: EfacturaMessageDTO[];
}

// ---------------------------------------------------------------------------
// SEO (Google Search Console)
// ---------------------------------------------------------------------------

export interface SeoRowDTO {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  clicksPrev: number;
  impressionsPrev: number;
  positionPrev: number | null;
}

export interface SeoIdeaDTO {
  title: string;
  query: string | null;
  why: string;
  outline: string[];
}

export interface SeoReportDTO {
  generatedAt: number;
  property: string;
  period: { start: string; end: string; prevStart: string; prevEnd: string };
  totals: { clicks: number; impressions: number; ctr: number; position: number; clicksPrev: number; impressionsPrev: number; ctrPrev: number; positionPrev: number };
  daily: Array<{ date: string; clicks: number; impressions: number }>;
  topQueries: SeoRowDTO[];
  risingQueries: SeoRowDTO[];
  fallingQueries: SeoRowDTO[];
  opportunities: SeoRowDTO[];
  topPages: SeoRowDTO[];
  fallingPages: SeoRowDTO[];
  sitemaps: Array<{ path: string; lastSubmitted: string | null; lastDownloaded: string | null; isPending: boolean; errors: number; warnings: number; submitted: number | null; indexed: number | null }>;
  inspections: Array<{ url: string; verdict: string | null; coverageState: string | null; indexingState: string | null; lastCrawlTime: string | null; robotsTxtState: string | null; googleCanonical: string | null }>;
  ideas: SeoIdeaDTO[];
}

export interface SeoOverviewDTO {
  configured: boolean;
  message: string | null;
  report: SeoReportDTO | null;
  running: boolean;
}

