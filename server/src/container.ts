import type { Config } from './config';
import type { DB } from './db';
import { getMeta, setMeta } from './db';
import type { Logger } from './logger';
import type { Services } from './services';
import { EventBus } from './events';
import { SettingsService } from './settings/service';
import { SecretsService } from './settings/secrets';
import { AuditService } from './audit';
import { Integrations } from './integrations';
import { LlmService } from './llm/service';
import { AuthService } from './auth/service';
import { Notifier } from './notifications/notifier';
import { ConversationStore } from './agent/conversations';
import { ApprovalService } from './agent/approvals';
import { AgentRunner } from './agent/runner';
import { MonitoringService } from './monitoring/service';
import { IncidentService } from './monitoring/incidents';
import { FindingsService } from './monitoring/findings';
import { BusinessService } from './monitoring/business';
import { TicketService } from './tickets/service';
import { ReportService } from './reports/service';
import { KnowledgeBase } from './knowledge/kb';
import { MemoryStore } from './knowledge/memory';
import { FileBackupStore } from './knowledge/fileBackups';
import { demoNet } from './demo/net';
import { DemoCloudflare, DemoDirectAdmin, DemoWhmcs, DemoWordPress } from './demo/integrations';
import { MockLlmProvider } from './demo/llm';

/** Construiește toate serviciile în ordinea corectă a dependențelor. */
export function buildServices(config: Config, log: Logger, db: DB): Services {
  const s = { config, db, log } as Services;
  s.bus = new EventBus();
  s.settings = new SettingsService(db, config.appUrl);
  s.secrets = new SecretsService(db, config.secretKey);
  s.audit = new AuditService(db);
  s.integrations = new Integrations(
    s.settings,
    s.secrets,
    config.demoMode
      ? { net: demoNet, whmcs: new DemoWhmcs(), directadmin: new DemoDirectAdmin(), reseller: new DemoDirectAdmin(), cloudflare: new DemoCloudflare(), wordpress: new DemoWordPress() }
      : null,
  );
  s.llm = new LlmService(db, s.settings, s.secrets, config.demoMode ? new MockLlmProvider() : null);
  s.integrations.setLlmTester(() => s.llm.testConnection());
  s.auth = new AuthService(db, config, s.secrets, s.audit, log, () => s.settings.get().general.agentName);
  s.notifier = new Notifier(s);
  s.conversations = new ConversationStore(db);
  s.approvals = new ApprovalService(s);
  s.agent = new AgentRunner(s);
  s.findings = new FindingsService(s);
  s.incidents = new IncidentService(s);
  s.business = new BusinessService(s);
  s.monitoring = new MonitoringService(s);
  s.tickets = new TicketService(s);
  s.reports = new ReportService(s);
  s.kb = new KnowledgeBase(db);
  s.memory = new MemoryStore(db);
  s.fileBackups = new FileBackupStore(db);

  // secretele generate de aplicație (pentru WordPress / WHMCS) și cheile pentru notificări push
  s.secrets.ensureGenerated('whmcs.webhookSecret');
  s.secrets.ensureGenerated('wordpress.secret');
  s.notifier.ensureVapid();

  if (config.demoMode) seedDemo(s);
  return s;
}

/** Date inițiale pentru modul demo: integrări „conectate” (simulate) și o bază de cunoștințe de exemplu. */
function seedDemo(s: Services): void {
  if (getMeta(s.db, 'demo_seeded')) return;
  s.settings.update({
    sites: { originIp: '203.0.113.10' },
    integrations: {
      whmcs: { enabled: true, replyAsAdmin: 'florin' },
      directadmin: { enabled: true, url: 'https://srv1.furnizor.ro:2222', username: 'datix' },
      cloudflare: { enabled: true },
      wordpress: { enabled: true },
    },
    general: { ownerName: 'Florin' },
  });
  s.kb.upsert({
    title: 'Pachete de găzduire web',
    tags: ['hosting', 'prețuri'],
    content:
      'Hosting Start: 1 site, 5 GB SSD, 5 conturi e-mail, SSL gratuit — 149 RON/an.\nHosting Standard: 3 site-uri, 15 GB SSD, 25 conturi e-mail, backup zilnic — 299 RON/an.\nHosting Business: site-uri nelimitate, 40 GB SSD, e-mail nelimitat, backup zilnic, prioritate la suport — 599 RON/an.\nToate pachetele includ panoul DirectAdmin, certificat SSL Let\'s Encrypt și protecție Cloudflare.',
  });
  s.kb.upsert({
    title: 'Configurare e-mail pe telefon (iPhone/Android)',
    tags: ['email', 'tutorial'],
    content:
      'Server primire (IMAP): mail.domeniulclientului.ro, port 993, SSL.\nServer trimitere (SMTP): mail.domeniulclientului.ro, port 465 SSL (sau 587 TLS), autentificare obligatorie cu adresa completă și parola contului.\nEroarea „serverul a respins expeditorul” înseamnă de obicei autentificare SMTP dezactivată.',
  });
  s.kb.upsert({
    title: 'Politica de rambursare și facturare',
    tags: ['facturare', 'politici'],
    content: 'Rambursările se aprobă doar de echipa Datix, după verificarea plăților. Plățile duble se returnează în maxim 5 zile lucrătoare sau se transformă în credit, la alegerea clientului.',
  });
  setMeta(s.db, 'demo_seeded', '1');
}
