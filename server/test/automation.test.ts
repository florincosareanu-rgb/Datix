import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { makeServices, waitFor } from './helpers';
import type { Services } from '../src/services';
import { cronFor, describeSchedule, normalizeSchedule, summaryLine, MissionError } from '../src/missions/service';
import { decide } from '../src/agent/policy';
import { getTool } from '../src/agent/tools';
import { zonedLocalToUtc } from '../src/util/time';
import { dynamicPlan } from '../src/scheduler';
import { daysBetween } from '../src/business/collections';
import { parseAnafDate, parseAnafErrors, anafMessageType } from '../src/integrations/anaf';
import { parseDmarc, dmarcXml } from '../src/maintenance/email';
import { mergeRows } from '../src/business/seo';
import { createZip } from '../src/util/zip';
import { unzip } from '../src/util/unzip';
import type { DemoWhmcs } from '../src/demo/integrations';

let s: Services;
let cleanup: () => void;
beforeEach(() => {
  ({ s, cleanup } = makeServices());
});
afterEach(() => cleanup());

describe('misiuni programate', () => {
  it('validează și descrie programarea în română', () => {
    const weekly = normalizeSchedule({ frequency: 'weekly', time: '9:05', weekdays: [4, 1, 1] });
    expect(weekly).toMatchObject({ time: '09:05', weekdays: [1, 4] });
    expect(cronFor(weekly)).toBe('5 9 * * 1,4');
    expect(describeSchedule(weekly)).toBe('în fiecare luni și joi la 09:05');
    expect(cronFor(normalizeSchedule({ frequency: 'hourly', time: '00:07', everyHours: 6 }))).toBe('7 */6 * * *');
    expect(describeSchedule(normalizeSchedule({ frequency: 'monthly', dayOfMonth: 15, time: '08:30' }))).toBe('lunar, pe 15 ale lunii, la 08:30');
    expect(() => normalizeSchedule({ frequency: 'weekly' })).toThrow(MissionError);
    expect(() => normalizeSchedule({ frequency: 'hourly', everyHours: 5 })).toThrow(/1, 2, 3, 4, 6, 8, 12/);
    expect(() => normalizeSchedule({ frequency: 'once', runAt: Date.now() - 3_600_000 })).toThrow(/trecut/);
  });

  it('ora locală din România devine timestamp corect, inclusiv cu ora de vară', () => {
    expect(new Date(zonedLocalToUtc('2026-01-15 09:00')!).toISOString()).toBe('2026-01-15T07:00:00.000Z');
    expect(new Date(zonedLocalToUtc('2026-07-15 09:00')!).toISOString()).toBe('2026-07-15T06:00:00.000Z');
    expect(zonedLocalToUtc('15.01.2026 9:00')).toBeNull();
  });

  it('prima frază din răspuns ajunge în notificare, fără Markdown', () => {
    expect(summaryLine('## Rezultat\n**3 facturi restante**, 1.240 RON.\n- detaliu')).toBe('Rezultat');
    expect(summaryLine('**3 facturi restante**, 1.240 RON.\n\n- detaliu')).toBe('3 facturi restante, 1.240 RON.');
  });

  it('o misiune creată din chat rulează, scrie o conversație și te anunță', async () => {
    const created = await getTool('mission_create')!.execute(
      { title: 'Facturi restante', prompt: 'Trimite-mi facturile restante.', frequency: 'weekly', time: '09:00', weekdays: [1], allow_changes: false },
      { services: s, context: 'owner', runId: 'test', conversationId: '' },
    );
    expect(created).toMatchObject({ created: true, schedule: 'în fiecare luni la 09:00' });
    const mission = s.missions.list().find((m) => m.title === 'Facturi restante' && m.createdBy === 'agent')!;
    expect(mission.nextRunAt).toBeGreaterThan(Date.now());
    const conversationId = await s.missions.execute(mission.id);
    expect(conversationId).toBeTruthy();
    const conv = s.conversations.get(conversationId!);
    expect(conv?.kind).toBe('mission');
    const after = s.missions.get(mission.id)!;
    expect(after.lastStatus).toBe('ok');
    expect(after.runCount).toBe(1);
    expect(s.notifier.list().some((n) => n.kind === 'mission' && n.url === `/chat/${conversationId}`)).toBe(true);
    // agentul a folosit uneltele de business (disponibile și în misiuni)
    const rows = s.conversations.rows(conversationId!);
    expect(rows.some((r) => r.role === 'tool')).toBe(true);
  });

  it('o misiune „o singură dată” se dezactivează după rulare', async () => {
    const m = s.missions.create({ title: 'Verificare unică', prompt: 'Verifică site-urile.', schedule: { frequency: 'once', runAt: Date.now() + 3_600_000 } });
    await s.missions.execute(m.id);
    expect(s.missions.get(m.id)!.enabled).toBe(false);
  });

  it('în misiuni, modificările cer aprobare dacă nu le-ai permis; mesajele către clienți nu sunt permise', () => {
    const st = s.settings.get();
    const write = getTool('wp_purge_cache')!;
    expect(decide(write, 'mission', st)).toMatchObject({ action: 'approval', blocking: false });
    expect(decide(write, 'mission', st, { missionAllowsChanges: true })).toEqual({ action: 'allow' });
    expect(decide(getTool('wp_reinstall_component')!, 'mission', st, { missionAllowsChanges: true })).toMatchObject({ action: 'approval', stepUp: true });
    expect(decide(getTool('collections_send_reminder')!, 'mission', st)).toMatchObject({ action: 'deny' });
    expect(decide(getTool('mission_create')!, 'mission', st)).toMatchObject({ action: 'deny' });
  });
});

describe('încasări', () => {
  it('pregătește reamintiri pentru factura restantă, comanda neterminată și domeniul care expiră', async () => {
    const o = await s.collections.scan('manual');
    const kinds = o.reminders.map((r) => r.kind).sort();
    expect(kinds).toEqual(['domain', 'invoice', 'order']);
    const inv = o.reminders.find((r) => r.kind === 'invoice')!;
    expect(inv.refLabel).toBe('DTX-2026-0412');
    expect(inv.daysOverdue).toBe(6);
    expect(inv.amountText).toBe('149,00 RON');
    expect(inv.message).toMatch(/Bună ziua, Maria,/);
    expect(inv.message).toContain('/viewinvoice.php?id=7001');
    expect(inv.message).toMatch(/Echipa Datix/);
    expect(o.totals).toMatchObject({ overdueInvoices: 1, expiringDomains: 1, pendingOrders: 1 });
    // o a doua scanare nu dublează ciornele
    const again = await s.collections.scan('manual');
    expect(again.reminders.filter((r) => r.status === 'draft')).toHaveLength(3);
  });

  it('trimite doar la cerere, prin WHMCS, și nu mai pregătește aceeași reamintire imediat', async () => {
    const o = await s.collections.scan('manual');
    const inv = o.reminders.find((r) => r.kind === 'invoice')!;
    const edited = s.collections.update(inv.id, { message: `${inv.message}\n\nP.S. Mulțumim!` });
    const sent = await s.collections.send(edited.id);
    expect(sent.status).toBe('sent');
    const whmcs = s.integrations.whmcs() as unknown as DemoWhmcs;
    expect(whmcs.sentEmails.at(-1)).toMatchObject({ clientId: 2, subject: inv.subject });
    expect(whmcs.sentEmails.at(-1)!.message).toContain('P.S. Mulțumim!');
    const rescan = await s.collections.scan('manual');
    expect(rescan.reminders.filter((r) => r.kind === 'invoice' && r.status === 'draft')).toHaveLength(0);
    await expect(s.collections.send(sent.id)).rejects.toThrow(/deja/);
  });

  it('calculează corect zilele dintre date', () => {
    expect(daysBetween('2026-09-24', '2026-10-01')).toBe(7);
    expect(daysBetween('2026-10-01 10:00:00', '2026-10-01')).toBe(0);
  });
});

describe('clienți în risc', () => {
  it('găsește clienții cu semnale și propune o acțiune', async () => {
    s.db.prepare("INSERT INTO events_inbox (source, event, at, data) VALUES ('whmcs', 'cancellation.request', ?, ?)").run(Date.now(), JSON.stringify({ userid: 3, reason: 'Mă mut la alt furnizor' }));
    const r = await s.churn.analyze('manual');
    const ion = r.clients.find((c) => c.clientId === 3)!;
    expect(ion.level).toBe('high');
    expect(ion.signals[0]!.code).toBe('cancellation_request');
    expect(ion.suggestion).toBeTruthy();
    const maria = r.clients.find((c) => c.clientId === 2)!;
    expect(maria.signals.map((x) => x.code)).toEqual(expect.arrayContaining(['overdue_invoice', 'domain_not_renewing']));
    expect(r.totals.high).toBeGreaterThanOrEqual(1);
    expect(r.totals.valueAtRisk).toBeGreaterThan(0);
    expect(s.churn.latest().generatedAt).toBeTruthy();
  });
});

describe('e-Factura (ANAF)', () => {
  it('interpretează datele, erorile și tipurile mesajelor ANAF', () => {
    expect(new Date(parseAnafDate('202601151415')).toISOString()).toBe('2026-01-15T12:15:00.000Z');
    expect(new Date(parseAnafDate('202607151415')).toISOString()).toBe('2026-07-15T11:15:00.000Z');
    expect(parseAnafErrors('<header><Errors errorMessage="E: [BR-RO-111] Cod &quot;RO-B&quot;"/><Errors errorMessage="E: alt"/></header>')).toEqual(['E: [BR-RO-111] Cod "RO-B"', 'E: alt']);
    expect(anafMessageType('ERORI FACTURA')).toBe('error');
    expect(anafMessageType('FACTURA TRIMISA')).toBe('sent');
    expect(anafMessageType('FACTURA PRIMITA')).toBe('received');
  });

  it('salvează mesajele și semnalează factura respinsă o singură dată', async () => {
    const r = await s.efactura.check();
    expect(r.status).toBe('degraded');
    const o = s.efactura.overview();
    expect(o.counts7d).toMatchObject({ sent: 6, errors: 1, received: 1 });
    const err = o.messages.find((m) => m.type === 'error')!;
    expect(err.errors[0]).toMatch(/BR-RO-111/);
    const findings = s.findings.list({ source: 'efactura', status: 'open' });
    expect(findings).toHaveLength(1);
    await s.efactura.check();
    expect(s.findings.list({ source: 'efactura', status: 'open' })).toHaveLength(1);
  });
});

describe('livrarea e-mailurilor', () => {
  it('citește rapoartele DMARC (xml, gz, zip)', () => {
    const xml = `<feedback><report_metadata><org_name>google.com</org_name><report_id>9</report_id><date_range><begin>1700000000</begin><end>1700086400</end></date_range></report_metadata><policy_published><domain>datix.ro</domain></policy_published><record><row><source_ip>1.2.3.4</source_ip><count>5</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row></record></feedback>`;
    const r = parseDmarc(xml)!;
    expect(r).toMatchObject({ org: 'google.com', reportId: '9', domain: 'datix.ro', records: [{ ip: '1.2.3.4', count: 5, dkim: 'pass', spf: 'fail' }] });
    expect(dmarcXml('r.xml.gz', gzipSync(xml))[0]).toBe(xml);
    const zip = createZip([{ name: 'r.xml', data: Buffer.from(xml) }]);
    expect(dmarcXml('r.zip', zip)[0]).toBe(xml);
    expect(unzip(zip)[0]!.data.toString()).toBe(xml);
  });

  it('testul real: WHMCS trimite, DAX găsește e-mailul în căsuță', async () => {
    const t = await s.email.runTest('manual');
    expect(t.status).toBe('ok');
    expect(t.latencySec).toBeGreaterThanOrEqual(0);
    const whmcs = s.integrations.whmcs() as unknown as DemoWhmcs;
    expect(whmcs.sentEmails.at(-1)!.subject).toMatch(/^DAX-TEST-/);
  });

  it('rapoartele DMARC arată serverele neautorizate', async () => {
    const r = await s.email.check();
    expect(r.message).toMatch(/DMARC 14 zile/);
    const spoof = s.findings.list({ source: 'email', status: 'open' }).find((f) => f.title.includes('neautorizate'));
    expect(spoof?.details).toContain('185.220.101.33');
    const o = await s.email.overview();
    expect(o.dmarc).toMatchObject({ messages: 421, failed: 3 });
  });
});

describe('SEO (Search Console)', () => {
  it('compară perioadele pe interogare', () => {
    const rows = mergeRows(
      [{ keys: ['hosting'], clicks: 10, impressions: 100, ctr: 0.1, position: 5.44 }],
      [
        { keys: ['hosting'], clicks: 6, impressions: 80, ctr: 0.075, position: 6.1 },
        { keys: ['vechi'], clicks: 4, impressions: 40, ctr: 0.1, position: 3 },
      ],
    );
    expect(rows[0]).toMatchObject({ key: 'hosting', clicks: 10, clicksPrev: 6, ctr: 10, position: 5.4, positionPrev: 6.1 });
    expect(rows.find((r) => r.key === 'vechi')).toMatchObject({ clicks: 0, clicksPrev: 4 });
  });

  it('generează raportul săptămânal cu oportunități, indexare și idei de articole', async () => {
    const r = await s.seo.generate('manual');
    expect(r.totals.clicks).toBeGreaterThan(0);
    expect(r.daily.length).toBeGreaterThanOrEqual(25);
    expect(r.opportunities.every((o) => o.impressions >= 50 && o.position >= 4 && o.position <= 20 && o.ctr < 3)).toBe(true);
    expect(r.opportunities.length).toBeGreaterThan(0);
    expect(r.inspections.some((i) => i.verdict === 'NEUTRAL')).toBe(true);
    expect(r.ideas.length).toBeGreaterThan(0);
    expect(s.seo.overview().report?.generatedAt).toBe(r.generatedAt);
  });
});

describe('programarea automatizărilor', () => {
  it('urmează setările (ora, ziua, activare)', () => {
    const st = s.settings.get();
    const plan = dynamicPlan(st);
    const byName = Object.fromEntries(plan.map((p) => [p.name, p.pattern]));
    expect(byName.report).toBe('0 8 * * *');
    expect(byName.backup).toBe('30 2 * * *');
    expect(byName.churn).toBe('15 9 * * 1');
    expect(byName.seo).toBe('40 8 * * 1');
    const off = dynamicPlan({ ...st, updates: { ...st.updates, mode: 'off' }, backups: { ...st.backups, enabled: false } });
    expect(off.some((p) => p.name === 'updates' || p.name === 'backup')).toBe(false);
  });

  it('API-ul misiunilor validează și răspunde în română', async () => {
    await expect(async () => s.missions.create({ title: 'x', prompt: 'ceva de făcut', schedule: { frequency: 'daily' } })).rejects.toThrow(/minim 3/);
    const m = s.missions.create({ title: 'Verificare', prompt: 'Verifică site-urile.', schedule: { frequency: 'weekdays', time: '07:30' } });
    expect(m.scheduleText).toBe('de luni până vineri la 07:30');
    const paused = s.missions.update(m.id, { enabled: false });
    expect(paused.nextRunAt).toBeNull();
    s.missions.runNow(m.id);
    await waitFor(() => s.missions.get(m.id)!.runCount === 1, 20_000);
  });
});
