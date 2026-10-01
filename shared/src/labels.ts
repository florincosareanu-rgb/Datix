// Etichete în limba română pentru interfață și notificări.

export const MONITOR_STATUS_LABEL: Record<string, string> = {
  up: 'Funcțional',
  down: 'Căzut',
  degraded: 'Degradat',
  unknown: 'Necunoscut',
  paused: 'Pe pauză',
};

export const INCIDENT_STATUS_LABEL: Record<string, string> = {
  open: 'Deschis',
  investigating: 'Se investighează',
  mitigated: 'Atenuat',
  resolved: 'Rezolvat',
};

export const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critic',
  high: 'Ridicat',
  medium: 'Mediu',
  low: 'Scăzut',
  info: 'Informativ',
};

export const TICKET_MODE_LABEL: Record<string, string> = {
  off: 'Oprit',
  draft: 'Ciornă',
  auto: 'Automat',
};

export const TICKET_JOB_STATUS_LABEL: Record<string, string> = {
  queued: 'În așteptare',
  analyzing: 'Se analizează',
  draft_ready: 'Ciornă pregătită',
  sent: 'Răspuns trimis',
  escalated: 'Necesită atenția ta',
  skipped: 'Doar notificat',
  discarded: 'Ignorat',
  error: 'Eroare',
};

export const ESCALATION_REASON_LABEL: Record<string, string> = {
  money: 'Bani (facturi, plăți, rambursări)',
  cancellation: 'Anulare sau ștergere',
  account_change: 'Modificare pe cont',
  complaint_legal: 'Reclamație sau aspect legal',
  low_confidence: 'Agentul nu e suficient de sigur',
  auto_reply_limit: 'Limita de răspunsuri automate atinsă',
  other: 'Alt motiv',
};

export const RISK_LABEL: Record<string, string> = {
  read: 'Doar citire',
  write: 'Modificare reversibilă',
  irreversible: 'Acțiune ireversibilă',
  customer_message: 'Mesaj către client',
};

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: 'Așteaptă aprobarea',
  approved: 'Aprobat',
  rejected: 'Respins',
  expired: 'Expirat',
  executed: 'Executat',
  failed: 'Eșuat',
};

export const INTEGRATION_LABEL: Record<string, string> = {
  llm: 'DeepSeek (AI)',
  whmcs: 'WHMCS (my.datix.ro)',
  directadmin: 'DirectAdmin',
  reseller: 'DirectAdmin Reseller',
  cloudflare: 'Cloudflare',
  wordpress: 'WordPress (plugin Datix AI)',
  pagespeed: 'Google PageSpeed',
};
