import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import type { BackupCheckDTO, BackupOverviewDTO, BackupRunDTO } from '@datix/shared';
import type { Services } from '../services';
import type { DaFileEntry } from '../integrations/directadmin';
import type { DirectAdminApi } from '../integrations/types';
import type { FindingInput } from '../monitoring/findings';
import { encryptStream } from './crypt';
import { scanTar } from './tar';
import { newId } from '../util/ids';
import { errorMessage, safeJsonParse, truncate } from '../util/text';
import { DAY, HOUR, MINUTE, formatDateTimeRo, formatDurationRo, sleep, zonedDate } from '../util/time';

// Backup verificat: DAX cere (sau găsește) backup-ul DirectAdmin, îl descarcă pe serverul DAX, verifică
// arhiva cap-coadă (baze de date, site-uri), o criptează și o copiază în afara serverului de hosting.

interface RunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: BackupRunDTO['status'];
  trigger: string;
  file: string | null;
  created_by_dax: number;
  size_bytes: number | null;
  sha256: string | null;
  destination: string | null;
  remote_key: string | null;
  encrypted: number;
  checks: string | null;
  log: string | null;
  error: string | null;
}

const toDTO = (r: RunRow): BackupRunDTO => ({
  id: r.id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  status: r.status,
  trigger: r.trigger,
  file: r.file,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  destination: r.destination,
  remoteKey: r.remote_key,
  encrypted: r.encrypted === 1,
  checks: safeJsonParse<BackupCheckDTO[]>(r.checks, []),
  log: safeJsonParse<string[]>(r.log, []),
  error: r.error,
});

export function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Data din listarea DirectAdmin (secunde, milisecunde sau text) → ms; null dacă nu se poate citi. */
export function parseDaTime(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Verifică arhiva de backup: se citește complet și conține bazele de date și fișierele site-urilor. */
export async function verifyArchive(path: string, expect: { databases: string[]; sitePaths: Array<{ label: string; marker: string }> }): Promise<{ entries: number; checks: BackupCheckDTO[] }> {
  const checks: BackupCheckDTO[] = [];
  let source: AsyncIterable<Buffer>;
  if (/\.tar\.gz$/i.test(path)) source = createReadStream(path).pipe(zlib.createGunzip());
  else if (/\.tar\.zst$/i.test(path)) {
    const zstd = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
    if (!zstd) {
      checks.push({ label: 'Arhiva se citește complet', ok: true, detail: 'Format zstd: Node.js de pe server nu îl poate verifica (doar mărimea și suma de control).' });
      return { entries: 0, checks };
    }
    source = createReadStream(path).pipe(zstd()) as unknown as AsyncIterable<Buffer>;
  } else source = createReadStream(path);

  let userConf = false;
  const dbs = new Set<string>();
  const sites = new Set<string>();
  let entries = 0;
  try {
    const r = await scanTar(source, (e) => {
      if (/(^|\/)backup\/user\.conf$/.test(e.name)) userConf = true;
      const db = /(?:^|\/)backup\/([^/]+)\.sql(?:\.gz|\.zst)?$/.exec(e.name);
      if (db) dbs.add(db[1]!);
      for (const s of expect.sitePaths) if (e.name === s.marker || e.name.endsWith(`/${s.marker}`)) sites.add(s.marker);
    });
    entries = r.entries;
    checks.push({ label: 'Arhiva se citește complet', ok: true, detail: `${entries.toLocaleString('ro-RO')} fișiere, ${formatBytes(r.bytes)} necomprimat` });
  } catch (err) {
    checks.push({ label: 'Arhiva se citește complet', ok: false, detail: `Arhiva e coruptă sau incompletă: ${errorMessage(err)}` });
    return { entries, checks };
  }
  checks.push({ label: 'Configurația contului', ok: userConf, detail: userConf ? 'user.conf prezent' : 'Lipsește backup/user.conf (restaurarea completă poate eșua)' });
  if (expect.databases.length) {
    const missing = expect.databases.filter((d) => !dbs.has(d));
    checks.push({ label: 'Bazele de date', ok: !missing.length, detail: missing.length ? `Lipsesc: ${missing.join(', ')}` : `${[...dbs].join(', ')}` });
  } else {
    checks.push({ label: 'Bazele de date', ok: dbs.size > 0, detail: dbs.size ? [...dbs].join(', ') : 'Nicio copie .sql în arhivă' });
  }
  for (const s of expect.sitePaths) checks.push({ label: s.label, ok: sites.has(s.marker), detail: sites.has(s.marker) ? s.marker : `Lipsește ${s.marker}` });
  return { entries, checks };
}

export class BackupService {
  private current: Promise<BackupRunDTO> | null = null;

  constructor(private readonly s: Services) {}

  private row(id: string): RunRow | null {
    return (this.s.db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;
  }

  runs(limit = 20): BackupRunDTO[] {
    return (this.s.db.prepare('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[]).map(toDTO);
  }

  lastOk(): BackupRunDTO | null {
    const r = this.s.db.prepare("SELECT * FROM backup_runs WHERE status IN ('ok', 'warning') AND remote_key IS NOT NULL ORDER BY started_at DESC LIMIT 1").get() as RunRow | undefined;
    return r ? toDTO(r) : null;
  }

  get running(): boolean {
    return !!this.current;
  }

  async overview(): Promise<BackupOverviewDTO> {
    const st = this.s.settings.get().backups;
    const da = this.s.integrations.isConfigured('directadmin');
    const storage = this.s.integrations.storage();
    let stored: BackupOverviewDTO['stored'] = [];
    let message: string | null = null;
    if (!da) message = 'Conectează DirectAdmin (Setări → Integrări) ca DAX să poată verifica backup-urile.';
    else if (!storage) message = 'Alege unde se păstrează copiile (Setări → Integrări → Stocare backup).';
    else if (!st.enabled) message = 'Backup-ul zilnic verificat e oprit. Activează-l mai jos.';
    if (storage) {
      try {
        stored = (await storage.list()).sort((a, b) => b.lastModified - a.lastModified).map((o) => ({ key: o.key, sizeBytes: o.sizeBytes, at: o.lastModified }));
      } catch (err) {
        message = `Nu pot lista copiile: ${errorMessage(err)}`;
      }
    }
    return {
      configured: da && !!storage,
      message,
      destinationLabel: storage?.label ?? (st.destination === 's3' ? 'S3 (neconfigurat)' : 'serverul DAX'),
      running: this.running,
      nextRunAt: null,
      lastOk: this.lastOk(),
      runs: this.runs(),
      stored,
    };
  }

  run(trigger: 'schedule' | 'manual' | 'agent'): Promise<BackupRunDTO> {
    if (this.current) return this.current;
    this.current = this.execute(newId('bk_'), trigger).finally(() => {
      this.current = null;
      this.s.bus.emit({ type: 'maintenance_changed', area: 'backup' });
    });
    return this.current;
  }

  /** Așteaptă apariția backup-ului cerut (DirectAdmin îl creează în fundal) și stabilizarea mărimii. */
  private async waitForNew(da: DirectAdminApi, before: DaFileEntry[], requestedAt: number): Promise<DaFileEntry | null> {
    const known = new Set(before.map((b) => `${b.name}:${b.sizeBytes}`));
    const step = this.s.config.demoMode ? 20 : 30_000;
    const deadline = Date.now() + (this.s.config.demoMode ? 2000 : 90 * MINUTE);
    let lastSize = -1;
    while (Date.now() < deadline) {
      const list = await da.listBackups();
      const fresh = list.find((f) => !known.has(`${f.name}:${f.sizeBytes}`) && (parseDaTime(f.modified) ?? Date.now()) >= requestedAt - 2 * MINUTE);
      if (fresh) {
        if (fresh.sizeBytes > 0 && fresh.sizeBytes === lastSize) return fresh;
        lastSize = fresh.sizeBytes;
      }
      await sleep(step);
    }
    return null;
  }

  private async execute(id: string, trigger: string): Promise<BackupRunDTO> {
    const st = this.s.settings.get().backups;
    const tz = this.s.settings.get().general.timezone;
    const log: string[] = [];
    const checks: BackupCheckDTO[] = [];
    const findings: FindingInput[] = [];
    const stamp = () => formatDateTimeRo(Date.now(), tz).slice(-5);
    const note = (m: string) => {
      log.push(`${stamp()} ${m}`);
      this.s.db.prepare('UPDATE backup_runs SET log = ?, checks = ? WHERE id = ?').run(JSON.stringify(log), JSON.stringify(checks), id);
    };
    this.s.db.prepare("INSERT INTO backup_runs (id, started_at, status, trigger, log, checks) VALUES (?, ?, 'running', ?, '[]', '[]')").run(id, Date.now(), trigger);
    this.s.bus.emit({ type: 'maintenance_changed', area: 'backup' });
    const tmpDir = join(this.s.config.dataDir, 'backup-tmp');
    let tmp: string | null = null;

    const finish = (status: BackupRunDTO['status'], error: string | null = null): BackupRunDTO => {
      this.s.db.prepare('UPDATE backup_runs SET status = ?, finished_at = ?, checks = ?, log = ?, error = ? WHERE id = ?').run(status, Date.now(), JSON.stringify(checks), JSON.stringify(log), error, id);
      this.s.db.prepare('DELETE FROM backup_runs WHERE started_at < ?').run(Date.now() - 365 * DAY);
      if (status === 'failed') {
        findings.push({ key: 'run_failed', severity: 'high', title: 'Backup-ul zilnic verificat a eșuat', details: error ?? undefined, recommendation: 'Deschide Mentenanță → Backup pentru detalii; DAX reîncearcă la următoarea rulare.' });
      }
      this.s.findings.report('backup', findings, { notifyFrom: 'critical' });
      return toDTO(this.row(id)!);
    };

    try {
      const da = this.s.integrations.directadmin();
      if (!da) return finish('failed', 'DirectAdmin nu e conectat.');
      const storage = this.s.integrations.storage();
      if (!storage) return finish('failed', 'Destinația copiilor nu e configurată (Setări → Integrări → Stocare backup).');

      // 1. backup nou (cerut acum) sau cel mai recent existent
      const before = await da.listBackups();
      let file: DaFileEntry | null = null;
      let created = false;
      if (st.createNew) {
        const requestedAt = Date.now();
        await da.createBackup();
        note('Am cerut un backup nou în DirectAdmin; aștept să fie gata…');
        file = await this.waitForNew(da, before, requestedAt);
        created = !!file;
        if (!file) note('Backup-ul nou nu a apărut în 90 de minute; verific ultimul backup existent.');
      }
      file ??= (await da.listBackups())[0] ?? null;
      if (!file) {
        findings.push({ key: 'missing', severity: 'critical', title: 'Nu există niciun backup al contului de hosting', recommendation: 'Verifică funcția de backup din DirectAdmin sau cere-i lui DAX să creeze unul.' });
        return finish('failed', 'Nu există niciun backup în /backups pe hosting.');
      }
      this.s.db.prepare('UPDATE backup_runs SET file = ?, created_by_dax = ?, size_bytes = ? WHERE id = ?').run(file.name, created ? 1 : 0, file.sizeBytes, id);
      const modified = parseDaTime(file.modified);
      const age = modified ? Date.now() - modified : null;
      checks.push({ label: 'Backup recent', ok: age == null || age < 26 * HOUR, detail: age == null ? 'data necunoscută' : `creat acum ${formatDurationRo(age)}` });
      if (age != null && age >= 26 * HOUR) {
        findings.push({ key: 'stale', severity: age > 3 * DAY ? 'critical' : 'high', title: `Cel mai nou backup are ${formatDurationRo(age)}`, recommendation: 'Backup-urile nu se mai fac zilnic. Activează „DAX cere un backup nou” sau verifică programarea din DirectAdmin.' });
      }

      // 2. mărimea față de ultima copie bună
      const prev = this.lastOk();
      if (!file.sizeBytes) {
        checks.push({ label: 'Mărime normală', ok: false, detail: 'Arhiva are 0 octeți' });
        return finish('failed', 'Arhiva de backup e goală.');
      }
      const shrunk = !!prev?.sizeBytes && file.sizeBytes < prev.sizeBytes * 0.6;
      checks.push({ label: 'Mărime normală', ok: !shrunk, detail: prev?.sizeBytes ? `${formatBytes(file.sizeBytes)} (anterior ${formatBytes(prev.sizeBytes)})` : formatBytes(file.sizeBytes) });
      if (shrunk) findings.push({ key: 'shrunk', severity: 'medium', title: `Backup-ul e mult mai mic decât precedentul (${formatBytes(file.sizeBytes)} față de ${formatBytes(prev!.sizeBytes)})`, recommendation: 'Poate lipsi o bază de date sau un site din backup. Verifică detaliile rulării.' });

      // 3. descărcare pe serverul DAX
      await mkdir(tmpDir, { recursive: true });
      tmp = join(tmpDir, `${id}-${file.name}`);
      note(`Descarc ${file.name} (${formatBytes(file.sizeBytes)})…`);
      const dl = await da.downloadToFile(`/backups/${file.name}`, tmp, { idleMs: 3 * MINUTE });
      this.s.db.prepare('UPDATE backup_runs SET sha256 = ?, size_bytes = ? WHERE id = ?').run(dl.sha256, dl.bytes, id);
      note(`Descărcat: ${formatBytes(dl.bytes)}, SHA-256 ${dl.sha256.slice(0, 12)}…`);

      // 4. verificarea conținutului
      const cfg = this.s.settings.get().integrations.directadmin;
      const sitePaths = [
        cfg.wordpressPath ? { label: 'Fișierele site-ului WordPress', marker: `${cfg.wordpressPath.replace(/^\/+|\/+$/g, '')}/wp-config.php` } : null,
        cfg.whmcsPath ? { label: 'Fișierele WHMCS', marker: `${cfg.whmcsPath.replace(/^\/+|\/+$/g, '')}/configuration.php` } : null,
      ].filter((x): x is { label: string; marker: string } => !!x);
      const databases = await da.listDatabases().catch(() => [] as string[]);
      const verification = await verifyArchive(tmp, { databases, sitePaths });
      checks.push(...verification.checks);
      const broken = verification.checks.filter((c) => !c.ok);
      note(broken.length ? `Verificare: ${broken.map((c) => `${c.label} — ${c.detail}`).join('; ')}` : 'Verificare: arhiva e completă.');
      if (broken.some((c) => c.label === 'Arhiva se citește complet')) {
        findings.push({ key: 'corrupt', severity: 'high', title: 'Arhiva de backup e coruptă', details: broken[0]?.detail ?? undefined, recommendation: 'Cere un backup nou din DirectAdmin; nu te baza pe această copie.' });
        return finish('failed', 'Arhiva de backup e coruptă.');
      }
      if (broken.length) findings.push({ key: 'incomplete', severity: 'high', title: 'Backup-ul nu conține tot ce trebuie', details: broken.map((c) => `${c.label}: ${c.detail}`).join(' · '), recommendation: 'Verifică ce secțiuni sunt incluse în backup-ul din DirectAdmin (domenii, baze de date).' });

      // 5. copie criptată în afara serverului de hosting
      const passphrase = st.encrypt ? this.s.secrets.ensureGenerated('backup.passphrase', 24) : null;
      const name = `${zonedDate(Date.now(), tz)}_${file.name}${passphrase ? '.enc' : ''}`;
      note(`Copiez în ${storage.label}${passphrase ? ' (criptat AES-256)' : ''}…`);
      const plain = createReadStream(tmp) as unknown as AsyncIterable<Buffer>;
      const up = await storage.upload(name, passphrase ? encryptStream(plain, passphrase) : plain);
      this.s.db.prepare('UPDATE backup_runs SET destination = ?, remote_key = ?, encrypted = ? WHERE id = ?').run(storage.label, up.key, passphrase ? 1 : 0, id);
      checks.push({ label: 'Copie în afara serverului', ok: true, detail: `${storage.label}: ${up.key} (${formatBytes(up.sizeBytes)})` });
      note(`Copie salvată: ${up.key}.`);

      // 6. păstrăm doar ultimele N copii
      const stored = (await storage.list()).sort((a, b) => b.lastModified - a.lastModified);
      for (const old of stored.slice(st.retain)) {
        await storage.delete(old.key);
        note(`Șters copia veche ${old.key}.`);
      }

      // 7. pe hosting rămân doar ultimele backup-uri create de DAX (doar după copia verificată)
      if (st.keepOnServer > 0 && created) {
        const mine = (this.s.db.prepare("SELECT file FROM backup_runs WHERE created_by_dax = 1 AND status IN ('ok', 'warning') AND file IS NOT NULL ORDER BY started_at DESC").all() as Array<{ file: string }>).map((r) => r.file);
        const keep = new Set([file.name, ...mine.slice(0, Math.max(0, st.keepOnServer - 1))]);
        const onServer = new Set((await da.listBackups()).map((f) => f.name));
        const remove = [...new Set(mine)].filter((f) => !keep.has(f) && onServer.has(f));
        if (remove.length) {
          await da.removePermanently(remove.map((f) => `/backups/${f}`));
          note(`Am eliberat spațiu pe hosting: ${remove.length} backup-uri vechi create de DAX (copiile sunt în ${storage.label}).`);
        }
      }

      const status: BackupRunDTO['status'] = checks.every((c) => c.ok) ? 'ok' : 'warning';
      const run = finish(status);
      if (status === 'warning') {
        void this.s.notifier.notify({ kind: 'maintenance', title: '⚠️ Backup verificat cu atenționări', body: checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join(' · '), priority: 'normal', url: '/mentenanta?tab=backup' });
      }
      return run;
    } catch (err) {
      const msg = errorMessage(err);
      note(`Eroare: ${msg}`);
      void this.s.notifier.notify({ kind: 'maintenance', title: '🚨 Backup-ul zilnic a eșuat', body: truncate(msg, 200, '…'), priority: 'high', url: '/mentenanta?tab=backup' });
      return finish('failed', msg);
    } finally {
      if (tmp) await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
