import type { UpdateItemDTO, UpdateRunDTO, UpdatesOverviewDTO } from '@datix/shared';
import type { Services } from '../services';
import { connectorSupports, type WpSnapshotItem } from '../integrations/wordpress';
import type { WordPressApi } from '../integrations/types';
import { getMeta, setMeta } from '../db';
import { newId } from '../util/ids';
import { errorMessage, safeJsonParse, truncate } from '../util/text';
import { formatDateTimeRo, sleep } from '../util/time';

// Actualizări WordPress sigure: verificare înainte, copie de siguranță (fișiere + baza de date),
// actualizare pe rând, verificarea paginilor-cheie după fiecare pas și revenire automată dacă ceva s-a stricat.

interface RunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: UpdateRunDTO['status'];
  trigger: string;
  items: string;
  log: string | null;
  error: string | null;
}

type Candidate = Omit<UpdateItemDTO, 'result' | 'message'>;

interface PageState {
  url: string;
  ok: boolean;
  bytes: number;
  reason: string | null;
}

const toDTO = (r: RunRow): UpdateRunDTO => ({
  id: r.id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  status: r.status,
  trigger: r.trigger,
  items: safeJsonParse<UpdateItemDTO[]>(r.items, []),
  log: safeJsonParse<string[]>(r.log, []),
  error: r.error,
});

const FAILED_META = 'updates_failed_versions';

/** „6.8.3” → „6.8”: aceeași ramură = actualizare minoră (de securitate). */
export function isMinorCoreUpdate(from: string, to: string): boolean {
  const branch = (v: string) => v.split('.').slice(0, 2).join('.');
  return branch(from) === branch(to);
}

export class UpdatesService {
  private current: Promise<UpdateRunDTO> | null = null;
  private currentId: string | null = null;

  constructor(private readonly s: Services) {}

  // ------------------------------------------------------------ citire

  private row(id: string): RunRow | null {
    return (this.s.db.prepare('SELECT * FROM update_runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;
  }

  runs(limit = 20): UpdateRunDTO[] {
    return (this.s.db.prepare('SELECT * FROM update_runs ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[]).map(toDTO);
  }

  private failedVersions(): Record<string, string> {
    return safeJsonParse<Record<string, string>>(getMeta(this.s.db, FAILED_META), {});
  }

  /** Ce actualizări sunt disponibile acum (și care sunt excluse de setări). */
  async pending(): Promise<UpdatesOverviewDTO['pending']> {
    const wp = this.s.integrations.wordpress();
    if (!wp) return [];
    const st = this.s.settings.get().updates;
    const failed = this.failedVersions();
    const [health, plugins] = await Promise.all([wp.health(), wp.plugins()]);
    const out: UpdatesOverviewDTO['pending'] = [];
    for (const p of plugins) {
      if (!p.update || p.slug === 'dax-connector') continue;
      out.push({ type: 'plugin', item: p.file, name: p.name, from: p.version, to: p.update, excluded: !st.plugins || st.exclude.includes(p.file) || failed[p.file] === p.update });
    }
    if (health.theme?.update) {
      out.push({ type: 'theme', item: health.theme.stylesheet, name: `Tema ${health.theme.name}`, from: health.theme.version, to: health.theme.update, excluded: !st.themes || st.exclude.includes(health.theme.stylesheet) });
    }
    if (health.updates.core) {
      const minor = isMinorCoreUpdate(health.wp_version, health.updates.core);
      out.push({ type: 'core', item: 'core', name: 'WordPress', from: health.wp_version, to: health.updates.core, excluded: minor ? !st.coreMinor : !st.coreMajor || failed.core === health.updates.core });
    }
    if (health.updates.translations) {
      out.push({ type: 'translations', item: 'translations', name: `Traduceri (${health.updates.translations})`, from: null, to: null, excluded: !st.translations });
    }
    return out;
  }

  async overview(): Promise<UpdatesOverviewDTO> {
    const available = this.s.integrations.isConfigured('wordpress');
    let pending: UpdatesOverviewDTO['pending'] = [];
    let message: string | null = available ? null : 'Conectează pluginul WordPress DAX (Setări → Integrări) pentru actualizări sigure.';
    if (available) {
      try {
        pending = await this.pending();
      } catch (err) {
        message = `Nu am putut citi actualizările: ${errorMessage(err)}`;
      }
    }
    return { available, message, running: !!this.current, nextRunAt: null, pending, runs: this.runs() };
  }

  // ------------------------------------------------------------ verificări

  private pageUrls(): string[] {
    const st = this.s.settings.get();
    return [...new Set([st.sites.wordpressUrl, ...st.updates.checkUrls].filter(Boolean))];
  }

  /** Verifică paginile direct pe serverul de hosting (ocolind cache-ul Cloudflare) și cu un parametru unic. */
  private async checkPages(baseline?: PageState[]): Promise<PageState[]> {
    const st = this.s.settings.get();
    const out: PageState[] = [];
    for (const url of this.pageUrls()) {
      const u = new URL(url);
      u.searchParams.set('dax_check', String(Date.now()));
      const r = await this.s.integrations.net
        .http({
          url: u.toString(),
          resolveTo: st.sites.originIp || undefined,
          insecure: !!st.sites.originIp,
          keyword: url === st.sites.wordpressUrl ? st.sites.wordpressKeyword || undefined : undefined,
          headers: { 'Cache-Control': 'no-cache' },
          timeoutMs: 30_000,
        })
        .catch((err) => ({ verdict: 'down' as const, bodyBytes: 0, bodyText: '', status: null, problems: [{ message: errorMessage(err) }], keywordFound: null }));
      const fatal = /There has been a critical error|Fatal error:|Parse error:|Eroare critică|A apărut o eroare critică/i.test(r.bodyText ?? '');
      const before = baseline?.find((b) => b.url === url);
      const shrunk = before && before.bytes > 2000 && r.bodyBytes < before.bytes * 0.4;
      const reason =
        r.verdict === 'down'
          ? (r.problems[0]?.message ?? 'pagina nu răspunde')
          : fatal
            ? 'pagina afișează o eroare PHP'
            : r.keywordFound === false
              ? 'lipsește textul așteptat din pagină'
              : shrunk
                ? `pagina e mult mai mică decât înainte (${r.bodyBytes} față de ${before!.bytes} octeți)`
                : null;
      out.push({ url, ok: !reason, bytes: r.bodyBytes, reason });
    }
    return out;
  }

  private async fatalLines(wp: WordPressApi): Promise<Set<string>> {
    try {
      const log = await wp.debugLog(80);
      return new Set(log.content.split('\n').filter((l: string) => /PHP (Fatal|Parse) error/.test(l)));
    } catch {
      return new Set();
    }
  }

  /** Site-ul e în regulă după un pas? Întoarce motivul dacă nu. */
  private async verify(wp: WordPressApi, baseline: PageState[], fatalBefore: Set<string>): Promise<string | null> {
    await sleep(this.s.config.demoMode ? 50 : 3000);
    const pages = await this.checkPages(baseline);
    const bad = pages.find((p) => !p.ok);
    if (bad) return `${bad.url}: ${bad.reason}`;
    try {
      await wp.health();
    } catch (err) {
      return `WordPress nu mai răspunde la verificare (${errorMessage(err)})`;
    }
    const fatalNow = await this.fatalLines(wp);
    const fresh = [...fatalNow].find((l) => !fatalBefore.has(l));
    if (fresh) return `eroare PHP nouă în jurnal: ${truncate(fresh.replace(/^\[[^\]]+\]\s*/, ''), 200, '…')}`;
    return null;
  }

  // ------------------------------------------------------------ rulare

  /** Pornește o rulare (o singură rulare odată). În modul „doar anunță”, rularea programată doar listează. */
  run(trigger: 'schedule' | 'manual' | 'agent'): Promise<UpdateRunDTO> {
    if (this.current) return this.current;
    const id = newId('upd_');
    this.currentId = id;
    this.current = this.execute(id, trigger).finally(() => {
      this.current = null;
      this.currentId = null;
      this.s.bus.emit({ type: 'maintenance_changed', area: 'updates' });
    });
    return this.current;
  }

  get runningId(): string | null {
    return this.currentId;
  }

  private async execute(id: string, trigger: string): Promise<UpdateRunDTO> {
    const st = this.s.settings.get().updates;
    const log: string[] = [];
    let items: UpdateItemDTO[] = [];
    const now = () => formatDateTimeRo(Date.now(), this.s.settings.get().general.timezone).slice(-5);
    const note = (msg: string) => {
      log.push(`${now()} ${msg}`);
      this.s.db.prepare('UPDATE update_runs SET log = ?, items = ? WHERE id = ?').run(JSON.stringify(log), JSON.stringify(items), id);
    };
    this.s.db.prepare("INSERT INTO update_runs (id, started_at, status, trigger, items, log) VALUES (?, ?, 'running', ?, '[]', '[]')").run(id, Date.now(), trigger);
    this.s.bus.emit({ type: 'maintenance_changed', area: 'updates' });
    const finish = (status: UpdateRunDTO['status'], error: string | null = null): UpdateRunDTO => {
      this.s.db.prepare('UPDATE update_runs SET status = ?, finished_at = ?, items = ?, log = ?, error = ? WHERE id = ?').run(status, Date.now(), JSON.stringify(items), JSON.stringify(log), error, id);
      this.s.db.prepare('DELETE FROM update_runs WHERE started_at < ?').run(Date.now() - 180 * 86_400_000);
      return toDTO(this.row(id)!);
    };

    const wp = this.s.integrations.wordpress();
    if (!wp) return finish('failed', 'Pluginul WordPress DAX nu e conectat.');
    try {
      const health = await wp.health();
      if (!connectorSupports(health.connector_version)) return finish('failed', `Pluginul DAX Connector ${health.connector_version} e prea vechi pentru actualizări sigure — descarcă versiunea nouă din Setări → Integrări → WordPress.`);

      const candidates: Candidate[] = (await this.pending()).filter((p) => !p.excluded).map(({ excluded: _e, ...c }) => c);
      items = candidates.map((c) => ({ ...c, result: 'pending', message: null }));
      if (!candidates.length) {
        note('Nicio actualizare de aplicat.');
        return finish('nothing');
      }
      if (trigger === 'schedule' && st.mode === 'notify') {
        note(`${candidates.length} actualizări disponibile; modul „doar anunță” — nu aplic nimic.`);
        void this.s.notifier.notify({
          kind: 'maintenance',
          title: `🔄 ${candidates.length === 1 ? 'O actualizare WordPress disponibilă' : `${candidates.length} actualizări WordPress disponibile`}`,
          body: `${candidates.map((c) => `${c.name}${c.to ? ` ${c.to}` : ''}`).slice(0, 4).join(', ')}. Le pot aplica sigur (cu revenire automată) dintr-o atingere.`,
          priority: 'low',
          url: '/mentenanta?tab=actualizari',
        });
        return finish('notified');
      }

      // 1. site-ul trebuie să meargă înainte de orice
      const baseline = await this.checkPages();
      const broken = baseline.find((p) => !p.ok);
      if (broken) {
        note(`Site-ul are deja o problemă (${broken.url}: ${broken.reason}) — nu actualizez peste o problemă existentă.`);
        items = items.map((i) => ({ ...i, result: 'skipped', message: 'Site-ul nu funcționa înainte de actualizare.' }));
        return finish('failed', 'Site-ul nu funcționa corect înainte de actualizare.');
      }
      const fatalBefore = await this.fatalLines(wp);
      note(`Verificare inițială OK (${baseline.length} pagini).`);

      // 2. copie de siguranță
      const snapItems: WpSnapshotItem[] = candidates.filter((c) => c.type === 'plugin' || c.type === 'theme').map((c) => ({ type: c.type as 'plugin' | 'theme', item: c.item }));
      let dbSaved = false;
      if (snapItems.length || (st.dbSnapshot && candidates.some((c) => c.type === 'core'))) {
        const snap = await wp.snapshot(id, snapItems, st.dbSnapshot);
        dbSaved = !!snap.db?.ok;
        for (const r of snap.items.filter((x) => !x.ok)) {
          const it = items.find((i) => i.item === r.item);
          if (it) {
            it.result = 'skipped';
            it.message = `Fără copie de siguranță (${r.message ?? 'eroare'}), nu risc actualizarea.`;
          }
        }
        note(`Copie de siguranță: ${snap.items.filter((x) => x.ok).length} componente${st.dbSnapshot ? `, baza de date ${dbSaved ? 'salvată' : `nesalvată (${snap.db?.message ?? 'eroare'})`}` : ''}.`);
      }

      // 3. pe rând, cu verificare după fiecare pas
      const failed = this.failedVersions();
      let stopped = false;
      for (const it of items) {
        if (it.result !== 'pending') continue;
        if (stopped) {
          it.result = 'skipped';
          it.message = 'Oprit după o problemă la un pas anterior.';
          continue;
        }
        const r = await wp.runUpdates(it.type, it.type === 'translations' || it.type === 'core' ? [] : [it.item]);
        const res = r.results.find((x) => x.item === it.item) ?? r.results[0];
        if (!res?.ok) {
          it.result = 'failed';
          it.message = res?.message ?? 'Actualizarea a eșuat.';
          note(`${it.name}: actualizarea a eșuat (${it.message}).`);
          continue;
        }
        const problem = await this.verify(wp, baseline, fatalBefore);
        if (!problem) {
          it.result = 'updated';
          it.message = `${it.from ?? ''} → ${res.to ?? it.to ?? ''}`.trim();
          note(`${it.name}: actualizat ${it.message}, site OK.`);
          continue;
        }

        note(`${it.name}: după actualizare ${problem}. Revin la versiunea anterioară…`);
        let fixed = false;
        if (it.type === 'plugin' || it.type === 'theme') {
          const rb = await wp.rollback(id, [{ type: it.type, item: it.item }]);
          note(`Revenire fișiere: ${rb.items[0]?.ok ? 'OK' : rb.items[0]?.message ?? 'eșuată'}.`);
          fixed = !(await this.verify(wp, baseline, fatalBefore));
        } else if (it.type === 'core' && it.from) {
          const rb = await wp.rollback(id, [], { coreVersion: it.from });
          note(`Reinstalare WordPress ${it.from}: ${rb.core?.ok ? 'OK' : rb.core?.message ?? 'eșuată'}.`);
          fixed = !(await this.verify(wp, baseline, fatalBefore));
        }
        if (!fixed && dbSaved) {
          const rb = await wp.rollback(id, [], { db: true });
          note(`Restaurarea bazei de date: ${rb.db?.ok ? 'OK' : rb.db?.message ?? 'eșuată'}.`);
          fixed = !(await this.verify(wp, baseline, fatalBefore));
        }
        if (it.to) failed[it.item] = it.to;
        setMeta(this.s.db, FAILED_META, JSON.stringify(failed));
        if (fixed) {
          it.result = 'rolled_back';
          it.message = `Versiunea ${it.to ?? 'nouă'} a stricat site-ul (${problem}); am revenit la ${it.from ?? 'versiunea anterioară'}. O sar automat până apare o versiune nouă.`;
          note(`${it.name}: site-ul funcționează din nou cu versiunea anterioară.`);
        } else {
          it.result = 'failed';
          it.message = `Site-ul nu și-a revenit după actualizarea la ${it.to ?? 'versiunea nouă'}: ${problem}.`;
          stopped = true;
          note(`${it.name}: revenirea nu a rezolvat problema — deschid un incident.`);
          this.s.incidents.open({
            monitorId: this.s.monitoring.getMonitor('site-wp') ? 'site-wp' : null,
            title: `Site-ul s-a stricat după actualizarea ${it.name} ${it.to ?? ''}`.trim(),
            severity: 'critical',
            details: `${problem}. Revenirea automată nu a rezolvat problema.`,
            data: { updateRun: id, item: it },
          });
        }
      }

      // 4. curățenie: cache și copii vechi
      if (items.some((i) => i.result === 'updated' || i.result === 'rolled_back')) await wp.purgeCache().catch(() => undefined);
      await wp.snapshotsCleanup(3).catch(() => undefined);

      const updated = items.filter((i) => i.result === 'updated');
      const rolled = items.filter((i) => i.result === 'rolled_back');
      const bad = items.filter((i) => i.result === 'failed');
      const status: UpdateRunDTO['status'] = bad.length ? 'failed' : rolled.length ? 'rolled_back' : 'ok';
      note(`Gata: ${updated.length} actualizate, ${rolled.length} revenite, ${bad.length} eșuate.`);
      const run = finish(status);
      void this.s.notifier.notify({
        kind: 'maintenance',
        title: bad.length ? '🚨 Actualizare WordPress cu probleme' : rolled.length ? '↩️ Am oprit o actualizare care strica site-ul' : `✅ ${updated.length === 1 ? 'O actualizare aplicată' : `${updated.length} actualizări aplicate`}`,
        body: [rolled[0]?.message, bad[0]?.message, updated.length ? `Actualizate: ${updated.map((u) => `${u.name}${u.to ? ` ${u.to}` : ''}`).slice(0, 4).join(', ')}.` : null].filter(Boolean).join(' '),
        priority: bad.length ? 'critical' : rolled.length ? 'high' : 'low',
        url: '/mentenanta?tab=actualizari',
      });
      return run;
    } catch (err) {
      const msg = errorMessage(err);
      note(`Eroare: ${msg}`);
      items = items.map((i) => (i.result === 'pending' ? { ...i, result: 'skipped', message: 'Rularea s-a oprit înainte de acest pas.' } : i));
      void this.s.notifier.notify({ kind: 'maintenance', title: 'Actualizările WordPress nu au rulat', body: truncate(msg, 200, '…'), priority: 'normal', url: '/mentenanta?tab=actualizari' });
      return finish('failed', msg);
    }
  }
}
