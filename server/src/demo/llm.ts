import type { LlmMessage, LlmProvider, LlmRequest, LlmResult, LlmStreamEvent, LlmToolCall } from '../llm/types';
import { normalizeText, detectEscalation } from '../tickets/escalation';

// Simulatorul de AI pentru modul demo (fără cheie DeepSeek) și pentru teste.
// Nu „gândește”: urmează scenarii simple, dar folosește uneltele reale ale aplicației,
// astfel încât interfața, aprobările și fluxurile să poată fi încercate cap-coadă.

export type ScriptStep = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> };
export type Script = (req: LlmRequest) => ScriptStep;

let callCounter = 0;
const call = (name: string, args: Record<string, unknown>): LlmToolCall => ({
  id: `demo_${Date.now().toString(36)}_${(callCounter++).toString(36)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function contextOf(req: LlmRequest): 'owner' | 'incident' | 'ticket' | 'report' {
  const sys = req.messages[0]?.role === 'system' ? req.messages[0].content : '';
  if (sys.includes('A fost detectat automat un incident')) return 'incident';
  if (sys.includes('Analizezi un tichet de suport')) return 'ticket';
  if (sys.includes('Scrii raportul zilnic') || sys.includes('post-mortem') || sys.includes('2–4 puncte scurte')) return 'report';
  return 'owner';
}

/** Mesajele din tura curentă (după ultimul mesaj al utilizatorului). */
function currentTurn(messages: LlmMessage[]) {
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  const user = lastUser >= 0 ? (messages[lastUser] as { content: string }).content : '';
  const after = messages.slice(lastUser + 1);
  const calls: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];
  for (const m of after) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const res = after.find((x) => x.role === 'tool' && x.tool_call_id === tc.id) as { content: string } | undefined;
        calls.push({ name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}'), result: res?.content ?? '' });
      }
    }
  }
  return { user, calls };
}

const parseJson = (s: string): unknown => {
  const inner = s.replace(/^<untrusted_data[^>]*>\n?/, '').replace(/\n?<\/untrusted_data>$/, '');
  try {
    return JSON.parse(inner);
  } catch {
    return null;
  }
};

const has = (req: LlmRequest, name: string) => !!req.tools?.some((t) => t.function.name === name);

// ------------------------------------------------------------------------------- rezumate

const EMOJI: Record<string, string> = { up: '🟢', degraded: '🟠', down: '🔴', unknown: '⚪', paused: '⏸️' };

function summarize(calls: Array<{ name: string; result: string }>): string {
  const parts: string[] = [];
  for (const c of calls) {
    const data = parseJson(c.result) as Record<string, unknown> | Array<Record<string, unknown>> | null;
    if (data && !Array.isArray(data) && 'error' in data) {
      parts.push(`⚠️ **${c.name}** a eșuat: ${String(data.error)}`);
      continue;
    }
    switch (c.name) {
      case 'status_overview': {
        const d = data as { monitors: Array<{ name: string; status: string; message: string | null }>; openIncidents: unknown[]; securityFindings: { counts: Record<string, number> } };
        const down = d.monitors.filter((m) => m.status === 'down' || m.status === 'degraded');
        parts.push(
          `### Starea generală\n${down.length ? `Am găsit **${down.length} probleme**:` : 'Totul funcționează normal. ✅'}\n${d.monitors
            .slice(0, 12)
            .map((m) => `- ${EMOJI[m.status] ?? '⚪'} **${m.name}** — ${m.message ?? 'încă neverificat'}`)
            .join('\n')}\n\nIncidente deschise: **${d.openIncidents.length}**. Probleme de securitate deschise: ${d.securityFindings.counts.critical ?? 0} critice, ${d.securityFindings.counts.high ?? 0} ridicate, ${d.securityFindings.counts.medium ?? 0} medii.`,
        );
        break;
      }
      case 'get_security_findings': {
        const list = (data as Array<{ severity: string; title: string; recommendation: string | null }>) ?? [];
        parts.push(
          list.length
            ? `### Securitate\nAm găsit **${list.length}** probleme deschise. Cele mai importante:\n${list
                .slice(0, 6)
                .map((f) => `- **[${f.severity}]** ${f.title}${f.recommendation ? ` — _${f.recommendation}_` : ''}`)
                .join('\n')}`
            : '### Securitate\nNu există probleme de securitate deschise. ✅',
        );
        break;
      }
      case 'cf_security_events': {
        const d = data as { total: number; topCountries: Array<{ country: string; count: number }>; topIps: Array<{ ip: string; count: number }> };
        parts.push(`### Cloudflare\nÎn ultimele 24 h, Cloudflare a blocat sau verificat **${d.total}** cereri suspecte. Top țări: ${d.topCountries.map((x) => `${x.country} (${x.count})`).join(', ')}. Cel mai activ IP: ${d.topIps[0]?.ip ?? '—'}.`);
        break;
      }
      case 'whmcs_list_tickets': {
        const list = (data as Array<{ tid: string; subject: string; client: string; status: string }>) ?? [];
        parts.push(list.length ? `### Tichete care așteaptă răspuns\n${list.map((t) => `- **#${t.tid}** ${t.subject} — ${t.client} (${t.status})`).join('\n')}` : 'Nu există tichete care așteaptă răspuns. ✅');
        break;
      }
      case 'whmcs_business_stats': {
        const d = data as { incomeToday: number; incomeThisMonth: number; incomeThisYear: number; ordersPending: number; ticketsAwaitingReply: number };
        parts.push(`### Business\n- Încasări azi: **${d.incomeToday} RON**\n- Luna aceasta: **${d.incomeThisMonth} RON**\n- Anul acesta: **${d.incomeThisYear} RON**\n- Comenzi în așteptare: ${d.ordersPending}\n- Tichete care așteaptă răspuns: ${d.ticketsAwaitingReply}`);
        break;
      }
      case 'whmcs_unpaid_invoices': {
        const d = data as { total: number; invoices: Array<{ number: string; clientName: string; balance: number; dueDate: string; status: string }> };
        parts.push(`### Facturi neplătite (${d.total})\n${d.invoices.map((i) => `- ${i.number} — ${i.clientName}: ${i.balance} RON, scadentă ${i.dueDate} (${i.status})`).join('\n')}`);
        break;
      }
      case 'check_ssl': {
        const d = data as { message: string; host: string };
        parts.push(`### SSL ${d.host}\n${d.message}`);
        break;
      }
      case 'check_website': {
        const d = data as { url: string; verdict: string; status: number; timings: { totalMs: number }; problems: Array<{ message: string }> };
        parts.push(`### ${d.url}\n${EMOJI[d.verdict === 'up' ? 'up' : d.verdict]} HTTP ${d.status} în ${(d.timings.totalMs / 1000).toFixed(2)} s${d.problems.length ? `\n${d.problems.map((p) => `- ${p.message}`).join('\n')}` : ' — funcționează normal.'}`);
        break;
      }
      case 'da_account_usage': {
        const d = data as { diskPct: number; inodePct: number; bandwidthPct: number; package: string };
        parts.push(`### Hosting (${d.package})\n- Disc: **${d.diskPct}%**\n- Fișiere (inode): **${d.inodePct}%**\n- Trafic lunar: **${d.bandwidthPct}%**`);
        break;
      }
      case 'check_domain_expiry': {
        const d = data as { domain: string; daysLeft: number; expiresAt: string };
        parts.push(`### Domeniul ${d.domain}\nExpiră pe ${d.expiresAt?.slice(0, 10)} (în **${d.daysLeft} zile**).`);
        break;
      }
      case 'run_pagespeed': {
        const d = data as { strategy: string; scores: { performance: number; seo: number }; opportunities: Array<{ title: string }> };
        parts.push(`### Viteză (${d.strategy})\nPerformanță **${d.scores.performance}/100**, SEO ${d.scores.seo}/100.\n${d.opportunities.map((o) => `- ${o.title}`).join('\n')}`);
        break;
      }
      default:
        parts.push(`Am rulat **${c.name}**.`);
    }
  }
  return parts.join('\n\n');
}

// ------------------------------------------------------------------------------- scenarii

function ownerScript(req: LlmRequest): ScriptStep {
  const { user, calls } = currentTurn(req.messages);
  if (calls.length) {
    return { text: `${summarize(calls)}\n\n_Rulez în **modul demo**: datele sunt simulate. Conectează DeepSeek și integrările din Setări pentru date reale._` };
  }
  const t = normalizeText(user);
  const pick = (...names: Array<[string, Record<string, unknown>]>) => ({ toolCalls: names.filter(([n]) => has(req, n)).map(([name, args]) => ({ name, args })) });
  let step: ScriptStep | null = null;
  if (/securit|vulnerab|atac|hack|spart|malware/.test(t)) step = pick(['get_security_findings', {}], ['cf_security_events', { hours: 24 }]);
  else if (/tichet|ticket|suport|client/.test(t)) step = pick(['whmcs_list_tickets', { status: 'awaiting' }]);
  else if (/incas|vanzar|venit|bani|factur|business|comenz|cifre/.test(t)) step = pick(['whmcs_business_stats', { days: 30 }], ['whmcs_unpaid_invoices', { status: 'Unpaid' }]);
  else if (/ssl|certificat/.test(t)) step = pick(['check_ssl', { domain: 'datix.ro' }], ['check_ssl', { domain: 'my.datix.ro' }]);
  else if (/viteza|pagespeed|lent|incet|rapid|seo/.test(t)) step = pick(['run_pagespeed', { url: 'https://datix.ro', strategy: 'mobile' }]);
  else if (/domeniu|expir/.test(t)) step = pick(['check_domain_expiry', { domain: 'datix.ro' }]);
  else if (/hosting|spatiu|disc|resurse|inode/.test(t)) step = pick(['da_account_usage', {}]);
  else if (/verific|merge|functioneaza|cad|picat|status|stare|cum sta|totul|situat/.test(t)) step = pick(['status_overview', {}]);
  if (step?.toolCalls?.length) return step;
  return {
    text: `Salut! Sunt **DAX**, agentul AI al Datix (acum în **modul demo**, cu date simulate).\n\nPot să:\n- verific **starea site-urilor** (datix.ro, my.datix.ro), SSL, DNS, domenii;\n- analizez **securitatea** (WordPress, WHMCS, Cloudflare);\n- îți arăt **tichetele** și să pregătesc răspunsuri;\n- îți spun **cifrele de business** (încasări, facturi, comenzi);\n- **repar** site-ul când pică (de exemplu, dezactivez un plugin defect).\n\nÎncearcă: „Cum stau site-urile?”, „Verifică securitatea” sau „Ce tichete am?”.`,
  };
}

function incidentScript(req: LlmRequest): ScriptStep {
  const { user, calls } = currentTurn(req.messages);
  const url = /https?:\/\/[^\s)]+/.exec(user)?.[0] ?? 'https://datix.ro';
  const done = (n: string) => calls.filter((c) => c.name === n);
  if (!done('check_website').length) return { text: 'Verific site-ul, direct și prin serverul de hosting.', toolCalls: [{ name: 'check_website', args: { url } }, { name: 'check_website', args: { url, via_origin: true } }] };
  const lastCheck = parseJson(done('check_website').at(-1)!.result) as { verdict?: string; problems?: Array<{ code: string }> } | null;
  const critical = lastCheck?.problems?.some((p) => p.code === 'wp_critical_error');
  if (critical && has(req, 'wp_rescue_capture_errors') && !done('wp_rescue_capture_errors').length) {
    return { text: 'WordPress afișează „eroare critică”. Pornesc captura erorilor PHP ca să văd ce a picat.', toolCalls: [{ name: 'wp_rescue_capture_errors', args: { enabled: true } }] };
  }
  if (critical && done('wp_rescue_capture_errors').length && !done('wp_rescue_read_errors').length) {
    return { toolCalls: [{ name: 'check_website', args: { url } }, { name: 'wp_rescue_read_errors', args: { lines: 50 } }] };
  }
  const errors = done('wp_rescue_read_errors').at(-1)?.result ?? '';
  const plugin = /wp-content\/plugins\/([a-z0-9_-]+)\//i.exec(errors)?.[1];
  if (critical && plugin && !done('wp_rescue_disable_plugins').length) {
    return { text: `Eroarea vine din pluginul **${plugin}**. Îl dezactivez temporar (fără să-l șterg) și verific din nou.`, toolCalls: [{ name: 'wp_rescue_disable_plugins', args: { plugins: [plugin] } }] };
  }
  if (done('wp_rescue_disable_plugins').length && done('check_website').length < 4) {
    return { toolCalls: [{ name: 'check_website', args: { url } }, { name: 'wp_rescue_capture_errors', args: { enabled: false } }] };
  }
  if (!done('incident_report').length) {
    const ok = lastCheck?.verdict === 'up';
    return {
      toolCalls: [
        {
          name: 'incident_report',
          args: ok
            ? {
                status: plugin ? 'resolved' : 'false_alarm',
                root_cause: plugin ? `Pluginul WordPress „${plugin}” provoca o eroare fatală PHP.` : 'Site-ul răspunde normal la verificare.',
                actions_taken: plugin ? ['Am capturat erorile PHP', `Am dezactivat temporar pluginul ${plugin}`, 'Am verificat că site-ul funcționează'] : ['Am verificat site-ul direct și prin Cloudflare'],
                summary: plugin
                  ? `Site-ul a picat din cauza pluginului „${plugin}”. L-am dezactivat temporar prin trusa de salvare și site-ul funcționează din nou. Recomand să actualizezi sau să înlocuiești pluginul înainte de a-l reactiva.`
                  : 'Site-ul funcționează normal; problema a fost probabil temporară.',
                recommendations: plugin ? [`Actualizează pluginul ${plugin} într-un mediu de test`, 'Reactivează-l doar după ce confirmi că eroarea a dispărut'] : [],
              }
            : {
                status: 'needs_human',
                root_cause: 'Nu am putut identifica sigur cauza.',
                actions_taken: ['Am verificat site-ul direct și prin Cloudflare'],
                summary: 'Site-ul încă nu răspunde corect și nu am găsit o remediere sigură. Am nevoie de tine.',
                recommendations: ['Verifică panoul DirectAdmin și contactează furnizorul de hosting'],
              },
        },
      ],
    };
  }
  return { text: 'Investigația s-a încheiat. Detaliile sunt în raportul incidentului.' };
}

function ticketScript(req: LlmRequest): ScriptStep {
  const { user, calls } = currentTurn(req.messages);
  const clientId = Number(/client_id=(\d+)/.exec(user)?.[1] ?? 0);
  if (!calls.length) {
    const tc: ScriptStep['toolCalls'] = [];
    if (clientId && has(req, 'whmcs_client_overview')) tc.push({ name: 'whmcs_client_overview', args: { client_id: clientId } });
    if (has(req, 'kb_search')) tc.push({ name: 'kb_search', args: { query: /Subiect: (.+)/.exec(user)?.[1] ?? 'suport' } });
    if (tc.length) return { toolCalls: tc };
  }
  if (calls.some((c) => c.name === 'submit_ticket_analysis')) return { text: 'Analiza tichetului a fost trimisă.' };
  const text = normalizeText(user);
  const flags = detectEscalation(user);
  const isEmail = /e-?mail|smtp|outlook|iphone|expeditor/.test(text);
  const isSlow = /greu|lent|incet|secunde/.test(text);
  const reply = isEmail
    ? 'Bună ziua,\n\nVă mulțumim că ne-ați scris. Eroarea „Serverul a respins expeditorul” apare de obicei când pe telefon nu este activată autentificarea pentru serverul de trimitere (SMTP).\n\nVă rugăm să verificați pe iPhone:\n1. Setări → Mail → Conturi → contul dumneavoastră → Cont → Server SMTP (de ieșire);\n2. la serverul principal, activați „Autentificare: Parolă” și folosiți aceeași adresă de e-mail și parolă ca la primire;\n3. portul 465 cu SSL activ (sau 587 cu TLS).\n\nDacă eroarea persistă după acești pași, răspundeți la acest mesaj și verificăm împreună setările contului.'
    : isSlow
      ? 'Bună ziua,\n\nVă mulțumim pentru răbdare. Am verificat site-ul și am observat timpi de încărcare mari pe pagina de produse, cauzați în principal de imagini neoptimizate și de lipsa cache-ului de pagină.\n\nVă propunem:\n1. activarea cache-ului (LiteSpeed Cache);\n2. optimizarea imaginilor (conversie WebP);\n3. o verificare a pluginurilor active.\n\nUn coleg vă contactează astăzi pentru a aplica optimizările în cadrul mentenanței.'
      : 'Bună ziua,\n\nVă mulțumim pentru mesaj. Am înregistrat solicitarea dumneavoastră, iar un coleg din echipa Datix revine în cel mai scurt timp cu detalii.';
  return {
    toolCalls: [
      {
        name: 'submit_ticket_analysis',
        args: {
          category: flags.includes('money') ? 'facturare' : isEmail ? 'email' : isSlow ? 'website' : 'altul',
          urgency: flags.includes('complaint_legal') || flags.includes('money') ? 'high' : 'normal',
          sentiment: /inacceptabil|!/.test(user) ? 'frustrat' : 'neutru',
          language: 'ro',
          escalation: {
            money: flags.includes('money'),
            cancellation: flags.includes('cancellation'),
            account_change: flags.includes('account_change'),
            complaint_legal: flags.includes('complaint_legal'),
          },
          confidence: flags.length ? 0.55 : isEmail || isSlow ? 0.86 : 0.5,
          summary: flags.includes('money')
            ? 'Clientul reclamă o plată dublă și cere returnarea banilor. Necesită verificarea facturilor și decizia ta.'
            : isEmail
              ? 'Clientul nu poate trimite e-mailuri de pe iPhone (SMTP respinge expeditorul). Probabil autentificarea SMTP e dezactivată pe telefon.'
              : isSlow
                ? 'Clientul reclamă încărcarea lentă a site-ului; a revenit cu o întrebare.'
                : 'Solicitare generală.',
          internal_note: 'Analiză generată în modul demo.',
          customer_reply: reply,
          proposed_actions: flags.includes('money') ? ['Verifică în WHMCS dacă există două plăți pentru aceeași factură și emite rambursarea/creditul dacă e cazul'] : [],
        },
      },
    ],
  };
}

function reportScript(req: LlmRequest): ScriptStep {
  const last = req.messages.at(-1);
  const content = last && 'content' in last ? String(last.content ?? '') : '';
  if (content.includes('Incident:')) {
    return { text: '**Ce s-a întâmplat:** site-ul a fost indisponibil pentru scurt timp.\n\n**Cauza:** o eroare într-un plugin WordPress.\n\n**Cum s-a rezolvat:** agentul a dezactivat temporar pluginul prin trusa de salvare.\n\n**Cum prevenim:** actualizează pluginurile întâi pe o copie de test.' };
  }
  return { text: '- Site-urile au funcționat normal în ultimele 24 de ore.\n- Două pluginuri WordPress au actualizări — merită actualizate săptămâna aceasta.\n- O factură e restantă: trimite o reamintire clientului.' };
}

export const demoScript: Script = (req) => {
  switch (contextOf(req)) {
    case 'incident':
      return incidentScript(req);
    case 'ticket':
      return ticketScript(req);
    case 'report':
      return reportScript(req);
    default:
      return ownerScript(req);
  }
};

export class MockLlmProvider implements LlmProvider {
  readonly name = 'demo';

  constructor(
    private readonly script: Script = demoScript,
    private readonly delayMs = 12,
  ) {}

  async listModels() {
    return ['demo'];
  }

  async stream(req: LlmRequest, onEvent: (e: LlmStreamEvent) => void, signal?: AbortSignal): Promise<LlmResult> {
    const step = this.script(req);
    onEvent({ type: 'reasoning_delta', text: '…' });
    await new Promise((r) => setTimeout(r, this.delayMs * 10));
    let content = '';
    if (step.text) {
      const words = step.text.split(/(\s+)/);
      for (const w of words) {
        if (signal?.aborted) throw new Error('anulat');
        content += w;
        onEvent({ type: 'text_delta', text: w });
        if (this.delayMs && w.trim()) await new Promise((r) => setTimeout(r, this.delayMs));
      }
    }
    const toolCalls = (step.toolCalls ?? []).map((tc) => call(tc.name, tc.args));
    toolCalls.forEach((tc, index) => onEvent({ type: 'tool_call_started', index, id: tc.id, name: tc.function.name }));
    const promptChars = req.messages.reduce((n, m) => n + ('content' in m && m.content ? String(m.content).length : 0), 0);
    return {
      model: 'demo',
      content,
      reasoning: '',
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: { promptTokens: Math.round(promptChars / 4), cacheHitTokens: 0, completionTokens: Math.round(content.length / 4) + toolCalls.length * 30, reasoningTokens: 0 },
    };
  }
}
