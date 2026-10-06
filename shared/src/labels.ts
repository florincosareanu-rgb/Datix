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
  wordpress: 'WordPress (plugin DAX)',
  pagespeed: 'Google PageSpeed',
  storage: 'Stocare backup (S3 / R2)',
  mailbox: 'Căsuța de monitorizare (IMAP)',
  anaf: 'ANAF e-Factura (SPV)',
  gsc: 'Google Search Console',
};

export const EFACTURA_TYPE_LABEL: Record<string, string> = {
  sent: 'Factură trimisă',
  received: 'Factură primită',
  error: 'Factură respinsă',
  buyer_message: 'Mesaj de la cumpărător',
  other: 'Alt mesaj',
};

export const REMINDER_KIND_LABEL: Record<string, string> = {
  invoice: 'Factură restantă',
  order: 'Comandă neterminată',
  domain: 'Domeniu care expiră',
};

export const UPDATE_RESULT_LABEL: Record<string, string> = {
  pending: 'În așteptare',
  updated: 'Actualizat',
  rolled_back: 'Revenit la versiunea anterioară',
  failed: 'Eșuat',
  skipped: 'Sărit',
};

export const WEEKDAY_LABEL: Record<number, string> = {
  1: 'luni',
  2: 'marți',
  3: 'miercuri',
  4: 'joi',
  5: 'vineri',
  6: 'sâmbătă',
  7: 'duminică',
};
