import type { AppSettings } from '@datix/shared';

export function defaultSettings(appUrl: string): AppSettings {
  return {
    general: {
      agentName: 'DAX',
      companyName: 'Datix',
      ownerName: '',
      timezone: 'Europe/Bucharest',
      appUrl,
    },
    llm: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      incidentModel: 'deepseek-v4-flash',
      thinking: true,
      reasoningEffort: 'high',
      monthlyBudgetUsd: 10,
      hardStopAtBudget: true,
      maxStepsPerRun: 16,
      // prețuri DeepSeek V4 Flash (USD / 1M tokeni) — se pot ajusta din Setări dacă se schimbă
      priceInputPerM: 0.3,
      priceCacheHitPerM: 0.006,
      priceOutputPerM: 1.2,
    },
    sites: {
      wordpressUrl: 'https://datix.ro',
      whmcsUrl: 'https://my.datix.ro',
      wordpressKeyword: 'Datix',
      whmcsKeyword: '',
      originIp: '',
      extraUrls: [],
    },
    integrations: {
      whmcs: { enabled: false, url: 'https://my.datix.ro', replyAsAdmin: '' },
      directadmin: {
        enabled: false,
        url: '',
        username: '',
        wordpressPath: '/domains/datix.ro/public_html',
        whmcsPath: '/domains/my.datix.ro/public_html',
      },
      reseller: { enabled: false, url: '', username: '' },
      cloudflare: { enabled: false, zoneName: 'datix.ro', zoneId: '' },
      wordpress: { enabled: false, url: 'https://datix.ro' },
      pagespeed: { enabled: true },
    },
    monitoring: {
      uptimeIntervalSec: 60,
      failuresBeforeIncident: 2,
      successesBeforeResolve: 2,
      slowThresholdMs: 4000,
      autoInvestigate: true,
      escalateAfterMin: 10,
      dnsResolvers: ['1.1.1.1', '8.8.8.8'],
    },
    autonomy: {
      ownerConfirmIrreversible: true,
      incidentAutoRemediate: true,
      incidentAllowIrreversible: false,
    },
    tickets: {
      mode: 'draft',
      autoOnlyInSchedule: false,
      schedule: { weekdayStart: '20:00', weekdayEnd: '08:00', weekendsAllDay: true },
      escalate: { money: true, cancellation: true, accountChange: true, complaintLegal: true },
      minConfidence: 0.75,
      maxAutoRepliesPerTicketPerDay: 2,
      signature: 'Cu stimă,\nEchipa Datix',
      aiNote: 'Notă: acest răspuns a fost redactat cu ajutorul unui asistent AI. Dacă e nevoie, un coleg din echipa Datix preia imediat discuția.',
      addInternalNote: true,
      pollIntervalSec: 120,
      excludedDepartments: [],
    },
    notifications: {
      incidents: true,
      approvals: true,
      tickets: true,
      security: true,
      dailyReport: true,
      vapidSubject: 'mailto:contact@datix.ro',
    },
    reports: {
      dailyAt: '08:00',
      dailyEnabled: true,
    },
  };
}
