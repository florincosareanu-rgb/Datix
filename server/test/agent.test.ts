import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Services } from '../src/services';
import { demoState } from '../src/demo/state';
import { makeServices, waitFor } from './helpers';

// Scenarii cap-coadă cu simulatorul de AI (fără DeepSeek): uneltele, politica de autonomie,
// persistența și integrările simulate sunt cele reale ale aplicației.

let s: Services;
let cleanup: () => void;

beforeEach(() => {
  ({ s, cleanup } = makeServices());
  demoState.wpFault = false;
  demoState.rescueDisabled.clear();
});
afterEach(() => cleanup());

describe('chat cu proprietarul', () => {
  it('folosește unelte și răspunde, cu tot istoricul salvat', async () => {
    const convId = s.conversations.create('chat');
    const { runId } = s.agent.startOwnerMessage(convId, 'Cum stau site-urile?');
    const run = await waitFor(() => {
      const r = s.agent.getRun(runId);
      return r && r.status !== 'running' ? r : null;
    });
    expect(run.status).toBe('done');
    const rows = s.db.prepare('SELECT role, content, tool_name FROM messages WHERE conversation_id = ? ORDER BY seq').all(convId) as Array<{ role: string; content: string | null; tool_name: string | null }>;
    expect(rows[0]).toMatchObject({ role: 'user', content: 'Cum stau site-urile?' });
    expect(rows.some((r) => r.role === 'tool' && r.tool_name === 'status_overview')).toBe(true);
    expect(rows.at(-1)?.role).toBe('assistant');
    expect(s.conversations.get(convId)?.title).toBe('Cum stau site-urile?');
  });
});

describe('incident: site-ul cade din cauza unui plugin', () => {
  it('agentul găsește pluginul, îl dezactivează și site-ul revine', async () => {
    demoState.wpFault = true;
    const before = await s.monitoring.runNow('site-wp');
    expect(before.status).toBe('down');

    const inc = s.incidents.open({ monitorId: 'site-wp', title: 'datix.ro nu funcționează', severity: 'critical', details: 'HTTP 500: eroare critică WordPress' });
    const done = await waitFor(() => {
      const i = s.incidents.get(inc.id);
      return i && i.status === 'mitigated' ? i : null;
    }, 30_000);

    expect(demoState.rescueDisabled.has('elementor')).toBe(true);
    expect(done.rootCause).toContain('elementor');
    const kinds = s.incidents.events(inc.id).map((e) => e.kind);
    expect(kinds).toContain('agent_report');
    expect((await s.monitoring.runNow('site-wp')).status).toBe('up');
    // fiecare acțiune e în jurnal
    const actions = (s.db.prepare("SELECT action FROM audit_log WHERE actor = 'agent'").all() as Array<{ action: string }>).map((a) => a.action);
    expect(actions.some((a) => a.includes('wp_rescue_disable_plugins'))).toBe(true);
  });
});

describe('tichete în modul Automat', () => {
  it('răspunde singur doar la tichetele sigure; banii ajung mereu la proprietar', async () => {
    s.settings.update({ tickets: { mode: 'auto', autoOnlyInSchedule: false } });
    const whmcs = s.integrations.whmcs()!;
    const staffReplies = async (id: number) => (await whmcs.getTicket(id)).replies.filter((r) => r.isStaff).length;
    const moneyBefore = await staffReplies(102);

    await s.tickets.analyzeNow(101); // e-mail pe telefon — tehnic, sigur
    await s.tickets.analyzeNow(102); // bani retrași de două ori — escaladare obligatorie

    const job = (ticketId: number) => s.tickets.list({ limit: 50 }).find((j) => j.ticketId === ticketId);
    const safe = await waitFor(() => (job(101) && ['sent', 'draft_ready', 'escalated', 'error'].includes(job(101)!.status) ? job(101) : null), 30_000);
    const money = await waitFor(() => (job(102) && ['sent', 'draft_ready', 'escalated', 'error'].includes(job(102)!.status) ? job(102) : null), 30_000);

    expect(safe!.status).toBe('sent');
    expect(safe!.finalMessage).toContain('Echipa Datix');
    expect(safe!.finalMessage).toContain('asistent AI');
    expect(money!.status).toBe('escalated');
    expect(money!.escalationReasons).toContain('money');
    expect(await staffReplies(102)).toBe(moneyBefore);
  });

  it('în modul Ciornă, tichetele cu bani sunt marcate „necesită atenția ta”, cu ciornă', async () => {
    s.settings.update({ tickets: { mode: 'draft' } });
    await s.tickets.analyzeNow(102);
    const j = await waitFor(() => {
      const x = s.tickets.list({ limit: 50 }).find((y) => y.ticketId === 102);
      return x && x.status !== 'queued' && x.status !== 'analyzing' ? x : null;
    }, 30_000);
    expect(j.status).toBe('escalated');
    expect(j.escalationReasons).toContain('money');
    expect(j.draft?.length).toBeGreaterThan(20);
  });

  it('în modul Ciornă nu trimite nimic clientului', async () => {
    s.settings.update({ tickets: { mode: 'draft' } });
    const whmcs = s.integrations.whmcs()!;
    const before = (await whmcs.getTicket(101)).replies.length;
    await s.tickets.analyzeNow(101);
    const j = await waitFor(() => {
      const x = s.tickets.list({ limit: 50 }).find((y) => y.ticketId === 101);
      return x && x.status !== 'queued' && x.status !== 'analyzing' ? x : null;
    }, 30_000);
    expect(j.status).toBe('draft_ready');
    expect(j.draft?.length).toBeGreaterThan(20);
    expect((await whmcs.getTicket(101)).replies.length).toBe(before);
  });
});
