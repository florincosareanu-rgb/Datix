import { z } from 'zod';
import type { AppSettings } from '@datix/shared';

const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, 'Format oră: HH:MM');
const urlOrEmpty = z.union([z.literal(''), z.string().url()]);

export const settingsSchema = z.object({
  general: z.object({
    agentName: z.string().min(1).max(40),
    companyName: z.string().min(1).max(80),
    ownerName: z.string().max(80),
    timezone: z.string().min(1),
    appUrl: z.string(),
  }),
  llm: z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1).max(100),
    incidentModel: z.string().min(1).max(100),
    thinking: z.boolean(),
    reasoningEffort: z.enum(['low', 'high', 'max']),
    monthlyBudgetUsd: z.number().min(0).max(10000),
    hardStopAtBudget: z.boolean(),
    maxStepsPerRun: z.number().int().min(2).max(60),
    priceInputPerM: z.number().min(0),
    priceCacheHitPerM: z.number().min(0),
    priceOutputPerM: z.number().min(0),
  }),
  sites: z.object({
    wordpressUrl: urlOrEmpty,
    whmcsUrl: urlOrEmpty,
    wordpressKeyword: z.string().max(200),
    whmcsKeyword: z.string().max(200),
    originIp: z.union([z.literal(''), z.string().regex(/^[0-9a-fA-F:.]+$/, 'IP invalid')]),
    extraUrls: z.array(z.string().url()).max(50),
  }),
  integrations: z.object({
    whmcs: z.object({ enabled: z.boolean(), url: urlOrEmpty, replyAsAdmin: z.string().max(100) }),
    directadmin: z.object({
      enabled: z.boolean(),
      url: urlOrEmpty,
      username: z.string().max(100),
      wordpressPath: z.string().max(300),
      whmcsPath: z.string().max(300),
    }),
    reseller: z.object({ enabled: z.boolean(), url: urlOrEmpty, username: z.string().max(100) }),
    cloudflare: z.object({ enabled: z.boolean(), zoneName: z.string().max(253), zoneId: z.string().max(64) }),
    wordpress: z.object({ enabled: z.boolean(), url: urlOrEmpty }),
    pagespeed: z.object({ enabled: z.boolean() }),
  }),
  monitoring: z.object({
    uptimeIntervalSec: z.number().int().min(30).max(3600),
    failuresBeforeIncident: z.number().int().min(1).max(10),
    successesBeforeResolve: z.number().int().min(1).max(10),
    slowThresholdMs: z.number().int().min(500).max(60000),
    autoInvestigate: z.boolean(),
    escalateAfterMin: z.number().int().min(1).max(1440),
    dnsResolvers: z.array(z.string()).min(1).max(4),
  }),
  autonomy: z.object({
    ownerConfirmIrreversible: z.boolean(),
    incidentAutoRemediate: z.boolean(),
    incidentAllowIrreversible: z.boolean(),
  }),
  tickets: z.object({
    mode: z.enum(['off', 'draft', 'auto']),
    autoOnlyInSchedule: z.boolean(),
    schedule: z.object({ weekdayStart: hhmm, weekdayEnd: hhmm, weekendsAllDay: z.boolean() }),
    escalate: z.object({
      money: z.boolean(),
      cancellation: z.boolean(),
      accountChange: z.boolean(),
      complaintLegal: z.boolean(),
    }),
    minConfidence: z.number().min(0).max(1),
    maxAutoRepliesPerTicketPerDay: z.number().int().min(1).max(20),
    signature: z.string().max(500),
    aiNote: z.string().max(500),
    addInternalNote: z.boolean(),
    pollIntervalSec: z.number().int().min(30).max(3600),
    excludedDepartments: z.array(z.string()).max(50),
  }),
  notifications: z.object({
    incidents: z.boolean(),
    approvals: z.boolean(),
    tickets: z.boolean(),
    security: z.boolean(),
    dailyReport: z.boolean(),
    vapidSubject: z.string().regex(/^(mailto:|https:\/\/)/, 'Trebuie să înceapă cu mailto: sau https://'),
  }),
  reports: z.object({
    dailyAt: hhmm,
    dailyEnabled: z.boolean(),
  }),
}) satisfies z.ZodType<AppSettings>;
