import { z } from 'zod';
import { REMINDER_KIND_LABEL } from '@datix/shared';
import { defineTool, OPS, OWNER_ONLY, OWNER_REPORTS, READ_EVERYWHERE, ToolFailure } from './types';
import { needWp } from './helpers';
import { runIntegrity } from '../../maintenance/integrity';
import { connectorSupports } from '../../integrations/wordpress';
import { formatBytes } from '../../backups/service';
import { formatMoney } from '../../business/money';
import { errorMessage } from '../../util/text';

const OWNER_AND_MISSIONS = ['owner', 'mission'] as const;
const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : null);

export const automationTools = [
  // ------------------------------------------------------------------ backup
  defineTool({
    name: 'backup_status',
    label: 'Verific backup-urile',
    description: 'Starea backup-ului zilnic verificat: ultima copie bună, verificările arhivei, copiile păstrate în afara serverului, ultimele rulări.',
    schema: z.object({}),
    risk: 'read',
    contexts: [...OPS, 'report'],
    async execute(_a, ctx) {
      const o = await ctx.services.backups.overview();
      return {
        configured: o.configured,
        message: o.message,
        destination: o.destinationLabel,
        lastOk: o.lastOk ? { at: iso(o.lastOk.startedAt), file: o.lastOk.file, size: formatBytes(o.lastOk.sizeBytes), encrypted: o.lastOk.encrypted, checks: o.lastOk.checks } : null,
        storedCopies: o.stored.slice(0, 10).map((x) => ({ key: x.key, size: formatBytes(x.sizeBytes), at: iso(x.at) })),
        recentRuns: o.runs.slice(0, 5).map((r) => ({ at: iso(r.startedAt), status: r.status, error: r.error, failedChecks: r.checks.filter((c) => !c.ok) })),
      };
    },
  }),
  defineTool({
    name: 'backup_run_now',
    label: 'Pornesc un backup verificat',
    description: 'Pornește acum backup-ul verificat (cere backup în DirectAdmin, îl verifică, îl criptează și îl copiază în afara serverului). Durează câteva minute; rezultatul vine ca notificare.',
    schema: z.object({}),
    risk: 'write',
    contexts: [...OWNER_AND_MISSIONS],
    requires: ['directadmin'],
    summarize: () => 'Pornește backup-ul verificat',
    async execute(_a, ctx) {
      if (!ctx.services.integrations.storage()) throw new ToolFailure('Destinația copiilor nu e configurată (Setări → Integrări → Stocare backup).');
      void ctx.services.backups.run('agent').catch(() => undefined);
      return { started: true, note: 'Backup-ul rulează în fundal; proprietarul primește notificare doar dacă apare o problemă.' };
    },
  }),

  // ------------------------------------------------------------------ actualizări sigure
  defineTool({
    name: 'updates_status',
    label: 'Verific actualizările WordPress',
    description: 'Actualizările disponibile (pluginuri, temă, nucleu, traduceri), care sunt excluse și rezultatele ultimelor rulări sigure (inclusiv reveniri automate).',
    schema: z.object({}),
    risk: 'read',
    contexts: [...OPS, 'report'],
    requires: ['wordpress'],
    async execute(_a, ctx) {
      const o = await ctx.services.updates.overview();
      return { pending: o.pending, mode: ctx.services.settings.get().updates.mode, recentRuns: o.runs.slice(0, 5).map((r) => ({ at: iso(r.startedAt), status: r.status, items: r.items, error: r.error })) };
    },
  }),
  defineTool({
    name: 'updates_run_now',
    label: 'Pornesc actualizările sigure',
    description: 'Aplică acum actualizările WordPress în mod sigur: copie de siguranță, actualizare pe rând, verificarea site-ului după fiecare pas și revenire automată dacă ceva se strică. Rulează în fundal.',
    schema: z.object({}),
    risk: 'write',
    contexts: [...OWNER_AND_MISSIONS],
    requires: ['wordpress'],
    summarize: () => 'Aplică actualizările WordPress (cu revenire automată)',
    async execute(_a, ctx) {
      void ctx.services.updates.run('agent').catch(() => undefined);
      return { started: true, note: 'Actualizările rulează în fundal; rezultatul vine ca notificare.' };
    },
  }),

  // ------------------------------------------------------------------ integritate
  defineTool({
    name: 'wp_check_integrity',
    label: 'Verific integritatea fișierelor WordPress',
    description: 'Compară nucleul WordPress și pluginurile de pe wordpress.org cu sumele de control oficiale, caută fișiere PHP în uploads și verifică prin DirectAdmin că pluginul DAX nu a fost modificat.',
    schema: z.object({}),
    risk: 'read',
    contexts: READ_EVERYWHERE,
    requires: ['wordpress'],
    async execute(_a, ctx) {
      const r = await runIntegrity(ctx.services);
      ctx.services.findings.report('integrity', r.findings);
      return { ok: r.ok, message: r.message, problems: r.findings.map((f) => ({ severity: f.severity, title: f.title, details: f.details })), details: r.details };
    },
  }),
  defineTool({
    name: 'wp_reinstall_component',
    label: 'Reinstalez o componentă WordPress',
    description: 'Reinstalează aceeași versiune din sursa oficială wordpress.org peste fișierele modificate: un plugin (item = fișierul principal, ex. „akismet/akismet.php”) sau nucleul (type = core). Folosește-l când integritatea arată fișiere modificate.',
    schema: z.object({ type: z.enum(['plugin', 'core']), item: z.string().max(200).optional() }),
    risk: 'irreversible',
    contexts: OPS,
    requires: ['wordpress'],
    summarize: (a) => (a.type === 'core' ? 'Reinstalează nucleul WordPress (aceeași versiune) din sursa oficială' : `Reinstalează pluginul ${a.item} din sursa oficială wordpress.org`),
    async execute(a, ctx) {
      if (a.type === 'plugin' && !a.item) throw new ToolFailure('Pentru plugin trimite item = fișierul principal (ex. „contact-form-7/wp-contact-form-7.php”).');
      const wp = needWp(ctx);
      const health = await wp.health();
      if (!connectorSupports(health.connector_version)) throw new ToolFailure('Pluginul DAX Connector e prea vechi — proprietarul trebuie să-l actualizeze din Setări → Integrări → WordPress.');
      return wp.reinstall(a.type, a.item);
    },
  }),

  // ------------------------------------------------------------------ încasări
  defineTool({
    name: 'collections_overview',
    label: 'Verific încasările',
    description: 'Facturi restante, comenzi neterminate și domenii care expiră, cu reamintirile pregătite (ciorne) care așteaptă trimiterea de către proprietar.',
    schema: z.object({}),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['whmcs'],
    async execute(_a, ctx) {
      const o = ctx.services.collections.overview();
      return {
        updatedAt: iso(o.generatedAt),
        totals: { ...o.totals, overdueAmountText: formatMoney(o.totals.overdueAmount, o.currencyPrefix, o.currencySuffix), pendingAmountText: formatMoney(o.totals.pendingAmount, o.currencyPrefix, o.currencySuffix) },
        reminders: o.reminders.map((r) => ({ id: r.id, kind: REMINDER_KIND_LABEL[r.kind], ref: r.refLabel, client: r.clientName, amount: r.amountText, daysOverdue: r.daysOverdue, status: r.status, subject: r.subject })),
      };
    },
  }),
  defineTool({
    name: 'collections_prepare',
    label: 'Pregătesc reamintirile',
    description: 'Scanează acum WHMCS și pregătește reamintiri (ciorne) pentru facturile restante, comenzile neterminate și domeniile care expiră. Nu trimite nimic.',
    schema: z.object({}),
    risk: 'write',
    contexts: [...OWNER_AND_MISSIONS],
    requires: ['whmcs'],
    summarize: () => 'Pregătește reamintirile de plată (ciorne)',
    async execute(_a, ctx) {
      const o = await ctx.services.collections.scan('agent');
      return { drafts: o.reminders.filter((r) => r.status === 'draft').length, totals: o.totals, note: 'Ciornele așteaptă în aplicație (Business → Încasări); proprietarul le trimite.' };
    },
  }),
  defineTool({
    name: 'collections_send_reminder',
    label: 'Trimit o reamintire clientului',
    description: 'Trimite clientului (prin e-mail din WHMCS) o reamintire pregătită, după id. Proprietarul confirmă textul înainte de trimitere.',
    schema: z.object({ id: z.string().min(3) }),
    risk: 'customer_message',
    contexts: OWNER_ONLY,
    requires: ['whmcs'],
    summarize: (a) => `Trimite reamintirea ${a.id} clientului`,
    async execute(a, ctx) {
      const before = ctx.services.collections.get(a.id);
      if (!before) throw new ToolFailure('Reamintirea nu există.');
      const r = await ctx.services.collections.send(a.id);
      if (r.status !== 'sent') throw new ToolFailure(`Trimiterea a eșuat: ${r.error ?? 'eroare'}`);
      return { sent: true, client: r.clientName, subject: r.subject };
    },
  }),

  // ------------------------------------------------------------------ clienți în risc
  defineTool({
    name: 'churn_overview',
    label: 'Verific clienții în risc',
    description: 'Clienții care s-ar putea să plece (scor 0–100, semnale, acțiune propusă, valoare anuală). analyze=true recalculează acum.',
    schema: z.object({ analyze: z.boolean().default(false) }),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['whmcs'],
    async execute(a, ctx) {
      const r = a.analyze ? await ctx.services.churn.analyze('agent') : ctx.services.churn.latest();
      return {
        updatedAt: iso(r.generatedAt),
        message: r.message,
        totals: { ...r.totals, valueAtRiskText: formatMoney(r.totals.valueAtRisk, r.currencyPrefix, r.currencySuffix) },
        clients: r.clients.slice(0, 15).map((c) => ({ id: c.clientId, name: c.name, company: c.company, score: c.score, level: c.level, signals: c.signals.map((x) => x.label), suggestion: c.suggestion, annualValue: c.annualValue })),
      };
    },
  }),

  // ------------------------------------------------------------------ e-Factura
  defineTool({
    name: 'efactura_status',
    label: 'Verific e-Factura',
    description: 'Mesajele e-Factura din SPV (ANAF) din ultimele zile: facturi trimise, primite și mai ales cele respinse, cu erorile și explicația lor. check=true verifică acum la ANAF.',
    schema: z.object({ check: z.boolean().default(false) }),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['anaf'],
    async execute(a, ctx) {
      if (a.check) await ctx.services.efactura.check();
      const o = ctx.services.efactura.overview();
      return {
        connected: o.connected,
        message: o.message,
        last7days: o.counts7d,
        errors: o.messages.filter((m) => m.type === 'error').slice(0, 10).map((m) => ({ at: iso(m.createdAt), uploadId: m.uploadId, errors: m.errors, explanation: m.explanation })),
        recent: o.messages.slice(0, 15).map((m) => ({ at: iso(m.createdAt), type: m.type, details: m.details })),
      };
    },
  }),

  // ------------------------------------------------------------------ livrarea e-mailurilor
  defineTool({
    name: 'email_delivery_status',
    label: 'Verific livrarea e-mailurilor',
    description: 'Rezultatele testelor zilnice (WHMCS → căsuța de monitorizare), erorile de trimitere din WHMCS și rezumatul rapoartelor DMARC (cine trimite e-mailuri în numele domeniului).',
    schema: z.object({}),
    risk: 'read',
    contexts: [...OPS, 'report'],
    requires: ['mailbox'],
    async execute(_a, ctx) {
      const o = await ctx.services.email.overview();
      return { mailbox: o.mailbox, tests: o.tests.slice(0, 7), dmarcRecord: o.dmarcRecord, dmarc: o.dmarc, whmcsFailures24h: o.whmcsFailures24h };
    },
  }),
  defineTool({
    name: 'email_delivery_test',
    label: 'Testez livrarea e-mailurilor',
    description: 'Trimite acum un e-mail de test din WHMCS și verifică dacă ajunge (până la 10 minute). Rulează în fundal; rezultatul apare în Mentenanță → E-mail.',
    schema: z.object({}),
    risk: 'write',
    contexts: [...OWNER_AND_MISSIONS],
    requires: ['mailbox', 'whmcs'],
    summarize: () => 'Trimite un e-mail de test din WHMCS',
    async execute(_a, ctx) {
      if (!ctx.services.settings.get().email.whmcsTestClientId) throw new ToolFailure('Clientul de test din WHMCS nu e pregătit (Mentenanță → E-mail → Pregătește testul).');
      void ctx.services.email.runTest('agent').catch(() => undefined);
      return { started: true };
    },
  }),

  // ------------------------------------------------------------------ SEO
  defineTool({
    name: 'seo_report',
    label: 'Citesc raportul SEO',
    description: 'Ultimul raport SEO din Google Search Console: clicuri și afișări (săptămână vs. săptămâna trecută), căutări care urcă/coboară, oportunități, pagini neindexate, idei de articole.',
    schema: z.object({}),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['gsc'],
    async execute(_a, ctx) {
      const o = ctx.services.seo.overview();
      if (!o.report) return { message: o.message };
      const r = o.report;
      return {
        generatedAt: iso(r.generatedAt),
        period: r.period,
        totals: r.totals,
        topQueries: r.topQueries.slice(0, 10),
        risingQueries: r.risingQueries,
        fallingQueries: r.fallingQueries,
        opportunities: r.opportunities,
        fallingPages: r.fallingPages,
        notIndexed: r.inspections.filter((i) => i.verdict && i.verdict !== 'PASS'),
        sitemaps: r.sitemaps,
        ideas: r.ideas,
      };
    },
  }),
  defineTool({
    name: 'seo_search_performance',
    label: 'Citesc datele din Google Search Console',
    description: 'Performanța în căutările Google pe ultimele N zile, comparată cu perioada anterioară, după interogare, pagină, dată, țară sau dispozitiv. filter = text conținut în interogare/pagină (opțional).',
    schema: z.object({
      days: z.number().int().min(1).max(90).default(28),
      dimension: z.enum(['query', 'page', 'date', 'country', 'device']).default('query'),
      limit: z.number().int().min(1).max(100).default(25),
      filter: z.string().max(100).optional(),
    }),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['gsc'],
    async execute(a, ctx) {
      try {
        return await ctx.services.seo.performance(a);
      } catch (err) {
        throw new ToolFailure(errorMessage(err));
      }
    },
  }),
  defineTool({
    name: 'seo_inspect_url',
    label: 'Verific indexarea unei pagini',
    description: 'Starea în indexul Google a unei pagini (indexată sau nu, motivul, ultima accesare de către Google, canonical).',
    schema: z.object({ url: z.string().url() }),
    risk: 'read',
    contexts: OWNER_REPORTS,
    requires: ['gsc'],
    async execute(a, ctx) {
      try {
        return await ctx.services.seo.inspectUrl(a.url);
      } catch (err) {
        throw new ToolFailure(errorMessage(err));
      }
    },
  }),
];
