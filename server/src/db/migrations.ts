// Migrări SQLite. Se aplică în ordine, o singură dată; nu modifica o migrare deja publicată,
// adaugă una nouă la final.

export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- autentificare
CREATE TABLE admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  step_up_until INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  auth_method TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  at INTEGER NOT NULL,
  success INTEGER NOT NULL,
  method TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_at ON login_attempts(at);

-- ---------------------------------------------------------------- setări
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  hint TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE integration_status (
  key TEXT PRIMARY KEY,
  last_test_at INTEGER,
  last_test_ok INTEGER,
  last_test_message TEXT
);

-- ---------------------------------------------------------------- chat și agent
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Conversație nouă',
  kind TEXT NOT NULL DEFAULT 'chat',
  ref_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_conversations_updated ON conversations(updated_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  reasoning TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, seq);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  context TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT,
  model TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  steps INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_agent_runs_conv ON agent_runs(conversation_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  conversation_id TEXT,
  message_id TEXT,
  tool_call_id TEXT,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  risk TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  requires_step_up INTEGER NOT NULL DEFAULT 0,
  context TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  result TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status);

CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  model TEXT NOT NULL,
  context TEXT,
  run_id TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_llm_usage_at ON llm_usage(at);

-- ---------------------------------------------------------------- monitorizare
CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  interval_sec INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_check_at INTEGER,
  last_change_at INTEGER,
  last_message TEXT,
  last_latency_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  message TEXT,
  details TEXT
);
CREATE INDEX idx_check_results_monitor_at ON check_results(monitor_id, at);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  summary TEXT,
  root_cause TEXT,
  postmortem TEXT,
  conversation_id TEXT,
  last_notified_at INTEGER,
  notify_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_incidents_status ON incidents(status);

CREATE TABLE incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX idx_incident_events ON incident_events(incident_id, at);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  recommendation TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolved_at INTEGER,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_findings_status ON findings(status);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX idx_snapshots ON snapshots(kind, key, at);

-- ---------------------------------------------------------------- tichete
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  tid TEXT,
  subject TEXT,
  client_id INTEGER,
  client_name TEXT,
  email TEXT,
  department TEXT,
  priority TEXT,
  status TEXT,
  last_reply TEXT,
  last_processed_marker TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ticket_jobs (
  id TEXT PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  marker TEXT NOT NULL,
  trigger TEXT,
  status TEXT NOT NULL,
  mode TEXT,
  category TEXT,
  urgency TEXT,
  sentiment TEXT,
  escalation_reasons TEXT,
  confidence REAL,
  summary TEXT,
  analysis TEXT,
  draft TEXT,
  final_message TEXT,
  conversation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  error TEXT,
  UNIQUE(ticket_id, marker)
);
CREATE INDEX idx_ticket_jobs_status ON ticket_jobs(status);
CREATE INDEX idx_ticket_jobs_created ON ticket_jobs(created_at);

-- ---------------------------------------------------------------- notificări
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  read_at INTEGER,
  dedupe_key TEXT
);
CREATE INDEX idx_notifications_at ON notifications(at);

-- ---------------------------------------------------------------- rapoarte, audit, cunoștințe
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  content TEXT NOT NULL,
  data TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  context TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  result TEXT,
  ip TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);

CREATE TABLE kb_docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE file_backups (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  path TEXT NOT NULL,
  content BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_file_backups_path ON file_backups(target, path);

CREATE TABLE webhook_nonces (
  nonce TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX idx_webhook_nonces_at ON webhook_nonces(at);

CREATE TABLE events_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  event TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX idx_events_inbox ON events_inbox(source, event, at);
`,
  },
  {
    version: 2,
    name: 'automatizari',
    sql: `
-- misiuni programate din chat
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  allow_changes INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_status TEXT,
  last_summary TEXT,
  last_conversation_id TEXT,
  run_count INTEGER NOT NULL DEFAULT 0
);

-- reamintiri pregătite pentru clienți (facturi, comenzi, domenii)
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  ref_label TEXT NOT NULL,
  client_id INTEGER NOT NULL,
  client_name TEXT NOT NULL,
  client_email TEXT,
  amount REAL,
  currency TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  days_overdue INTEGER,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  error TEXT
);
CREATE INDEX idx_reminders_ref ON reminders(kind, ref_id, created_at);
CREATE INDEX idx_reminders_status ON reminders(status, updated_at);

-- analize calculate periodic (clienți în risc, încasări, SEO), ultima versiune contează
CREATE TABLE insights (
  kind TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, generated_at)
);

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  file TEXT,
  created_by_dax INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  sha256 TEXT,
  destination TEXT,
  remote_key TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  checks TEXT,
  log TEXT,
  error TEXT
);
CREATE INDEX idx_backup_runs_started ON backup_runs(started_at);

CREATE TABLE update_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  items TEXT NOT NULL,
  log TEXT,
  error TEXT
);
CREATE INDEX idx_update_runs_started ON update_runs(started_at);

CREATE TABLE efactura_messages (
  id TEXT PRIMARY KEY,
  cif TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  upload_id TEXT,
  details TEXT,
  errors TEXT,
  explanation TEXT,
  seen_at INTEGER NOT NULL
);
CREATE INDEX idx_efactura_created ON efactura_messages(created_at);

CREATE TABLE email_tests (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  received_at INTEGER,
  status TEXT NOT NULL,
  latency_sec INTEGER,
  error TEXT
);
CREATE INDEX idx_email_tests_sent ON email_tests(sent_at);

CREATE TABLE dmarc_reports (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  report_id TEXT NOT NULL,
  domain TEXT,
  date_begin INTEGER NOT NULL,
  date_end INTEGER NOT NULL,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  records TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_dmarc_end ON dmarc_reports(date_end);
`,
  },
];
