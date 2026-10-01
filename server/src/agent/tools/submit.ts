import { z } from 'zod';
import { defineTool } from './types';

export const ticketAnalysisSchema = z.object({
  category: z.enum(['tehnic', 'hosting', 'domeniu', 'email', 'website', 'facturare', 'vanzari', 'cont', 'abuz', 'altul']),
  urgency: z.enum(['low', 'normal', 'high', 'critical']),
  sentiment: z.enum(['pozitiv', 'neutru', 'frustrat', 'furios']),
  language: z.string().max(10).default('ro').describe('Limba în care a scris clientul (ro, en, ...)'),
  escalation: z.object({
    money: z.boolean().describe('Facturi, plăți, rambursări, reduceri, prețuri negociate'),
    cancellation: z.boolean().describe('Anulare servicii, ștergere cont/date, transfer la alt furnizor'),
    account_change: z.boolean().describe('Resetare parole, restaurare backup, DNS, upgrade/downgrade, coduri EPP/transfer'),
    complaint_legal: z.boolean().describe('Nemulțumire, reclamație, amenințări, GDPR, avocat, ANPC, abuz'),
  }),
  confidence: z.number().min(0).max(1).describe('Cât de sigur ești că răspunsul rezolvă corect cererea (0–1)'),
  summary: z.string().min(10).max(1500).describe('Pentru proprietar, în română: ce vrea clientul și ce ai constatat'),
  internal_note: z.string().max(6000).describe('Notă internă pentru echipă: verificările făcute și rezultatele'),
  customer_reply: z.string().min(20).max(12000).describe('Răspunsul către client, FĂRĂ semnătură (se adaugă automat)'),
  needs_human_reason: z.string().max(500).optional().describe('Dacă e nevoie de un om: de ce'),
  proposed_actions: z.array(z.string().max(300)).max(10).default([]).describe('Acțiuni pe care proprietarul le-ar putea face'),
});

export type TicketAnalysis = z.infer<typeof ticketAnalysisSchema>;

export const incidentReportSchema = z.object({
  status: z.enum(['resolved', 'mitigated', 'needs_human', 'false_alarm']),
  root_cause: z.string().max(1500),
  actions_taken: z.array(z.string().max(400)).max(30),
  summary: z.string().max(3000).describe('Rezumat clar, în română, pentru proprietar'),
  recommendations: z.array(z.string().max(400)).max(10).default([]),
});

export type IncidentReport = z.infer<typeof incidentReportSchema>;

export const submitTools = [
  defineTool({
    name: 'submit_ticket_analysis',
    label: 'Finalizez analiza tichetului',
    description: 'OBLIGATORIU la final: trimite analiza tichetului și răspunsul propus pentru client. Apelează o singură dată, după investigație.',
    schema: ticketAnalysisSchema,
    risk: 'read',
    contexts: ['ticket'],
    async execute(a, ctx) {
      ctx.services.agent.setOutcome(ctx.runId, 'ticket_analysis', a);
      return { received: true, note: 'Analiza a fost înregistrată. Nu mai e nevoie de alte acțiuni.' };
    },
  }),
  defineTool({
    name: 'incident_report',
    label: 'Raportez rezultatul incidentului',
    description: 'OBLIGATORIU la final: raportează cauza, ce ai făcut și starea (rezolvat / atenuat / necesită om / alarmă falsă).',
    schema: incidentReportSchema,
    risk: 'read',
    contexts: ['incident'],
    async execute(a, ctx) {
      ctx.services.agent.setOutcome(ctx.runId, 'incident_report', a);
      return { received: true };
    },
  }),
];
