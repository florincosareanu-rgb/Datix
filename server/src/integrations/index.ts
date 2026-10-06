import type { IntegrationKey, IntegrationStatusDTO } from '@datix/shared';
import type { SettingsService } from '../settings/service';
import type { SecretsService } from '../settings/secrets';
import { WhmcsClient } from './whmcs';
import { DirectAdminClient } from './directadmin';
import { CloudflareClient } from './cloudflare';
import { WordPressConnector } from './wordpress';
import { WpRescue } from './wpRescue';
import { realNet } from './net';
import { S3Client } from './s3';
import { MailboxClient } from './mailbox';
import { AnafClient } from './anaf';
import { SearchConsoleClient } from './gsc';
import { LocalStorage, S3Storage, type BackupStorage } from '../backups/storage';
import type { AnafApi, CloudflareApi, DirectAdminApi, GscApi, MailboxApi, NetApi, WhmcsApi, WordPressApi } from './types';
import { errorMessage } from '../util/text';

export interface DemoProviders {
  net: NetApi;
  whmcs: WhmcsApi;
  directadmin: DirectAdminApi;
  reseller: DirectAdminApi;
  cloudflare: CloudflareApi;
  wordpress: WordPressApi;
  mailbox: MailboxApi;
  anaf: (accessToken: string) => AnafApi;
  gsc: GscApi;
}

/**
 * Registrul integrărilor: construiește clienții din setări + secrete, la cerere.
 * Întoarce null pentru integrările dezactivate sau neconfigurate.
 */
export class Integrations {
  readonly net: NetApi;
  private readonly testers = new Map<IntegrationKey, () => Promise<string>>();

  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
    private readonly demo: DemoProviders | null = null,
    /** directorul pentru copiile locale ale backup-urilor (pe serverul DAX) */
    private readonly localBackupDir = '',
  ) {
    this.net = demo?.net ?? realNet;
  }

  get isDemo(): boolean {
    return !!this.demo;
  }

  setLlmTester(fn: () => Promise<string>): void {
    this.testers.set('llm', fn);
  }

  /** Testele care au nevoie de alte servicii (ex. ANAF reîmprospătează tokenul). */
  setTester(key: IntegrationKey, fn: () => Promise<string>): void {
    this.testers.set(key, fn);
  }

  whmcs(): WhmcsApi | null {
    const s = this.settings.get().integrations.whmcs;
    if (this.demo) return s.enabled ? this.demo.whmcs : null;
    const identifier = this.secrets.get('whmcs.identifier');
    const secret = this.secrets.get('whmcs.secret');
    if (!s.enabled || !s.url || !identifier || !secret) return null;
    return new WhmcsClient({ url: s.url, identifier, secret });
  }

  directadmin(): DirectAdminApi | null {
    const s = this.settings.get().integrations.directadmin;
    if (this.demo) return s.enabled ? this.demo.directadmin : null;
    const key = this.secrets.get('directadmin.loginKey');
    if (!s.enabled || !s.url || !s.username || !key) return null;
    return new DirectAdminClient({ url: s.url, username: s.username, loginKey: key });
  }

  /** Contul de reseller (funcție pregătită, activată când e cumpărat reseller-ul). */
  reseller(): DirectAdminApi | null {
    const s = this.settings.get().integrations.reseller;
    if (this.demo) return s.enabled ? this.demo.reseller : null;
    const key = this.secrets.get('reseller.loginKey');
    if (!s.enabled || !s.url || !s.username || !key) return null;
    return new DirectAdminClient({ url: s.url, username: s.username, loginKey: key });
  }

  cloudflare(): CloudflareApi | null {
    const s = this.settings.get().integrations.cloudflare;
    if (this.demo) return s.enabled ? this.demo.cloudflare : null;
    const token = this.secrets.get('cloudflare.apiToken');
    if (!s.enabled || !s.zoneName || !token) return null;
    return new CloudflareClient(token, s.zoneName, s.zoneId || undefined);
  }

  wordpress(): WordPressApi | null {
    const s = this.settings.get().integrations.wordpress;
    if (this.demo) return s.enabled ? this.demo.wordpress : null;
    const secret = this.secrets.get('wordpress.secret');
    if (!s.enabled || !s.url || !secret) return null;
    return new WordPressConnector(s.url, secret);
  }

  wpRescue(): WpRescue | null {
    const da = this.directadmin();
    const path = this.settings.get().integrations.directadmin.wordpressPath;
    if (!da || !path) return null;
    return new WpRescue(da, path);
  }

  pagespeedKey(): string | null {
    return this.secrets.get('pagespeed.apiKey');
  }

  /** Destinația copiilor de backup (S3/R2 sau directorul local de pe serverul DAX). */
  storage(): BackupStorage | null {
    const b = this.settings.get().backups;
    if (b.destination === 'local') return this.localBackupDir ? new LocalStorage(this.localBackupDir) : null;
    const accessKeyId = this.secrets.get('storage.accessKeyId');
    const secretAccessKey = this.secrets.get('storage.secretAccessKey');
    if (!b.s3.endpoint || !b.s3.bucket || !accessKeyId || !secretAccessKey) return null;
    const client = new S3Client({ endpoint: b.s3.endpoint, region: b.s3.region || 'auto', bucket: b.s3.bucket, accessKeyId, secretAccessKey, pathStyle: b.s3.pathStyle });
    const prefix = b.s3.prefix && !b.s3.prefix.endsWith('/') ? `${b.s3.prefix}/` : b.s3.prefix;
    return new S3Storage(client, prefix, b.s3.bucket);
  }

  /** Căsuța de monitorizare (teste de livrare + rapoarte DMARC). */
  mailbox(): MailboxApi | null {
    const e = this.settings.get().email;
    if (this.demo) return e.enabled ? this.demo.mailbox : null;
    const password = this.secrets.get('mailbox.password');
    if (!e.mailbox || !e.imapHost || !password) return null;
    return new MailboxClient({ host: e.imapHost, port: e.imapPort, user: e.mailbox, password });
  }

  /** Client ANAF cu un token de acces valid (tokenul îl gestionează serviciul e-Factura). */
  anafClient(accessToken: string): AnafApi {
    if (this.demo) return this.demo.anaf(accessToken);
    return new AnafClient(accessToken, this.settings.get().efactura.environment);
  }

  /** Google Search Console (cont de serviciu). */
  gsc(): GscApi | null {
    const s = this.settings.get().seo;
    if (this.demo) return s.enabled ? this.demo.gsc : null;
    const json = this.secrets.get('gsc.serviceAccount');
    if (!json) return null;
    try {
      return new SearchConsoleClient(json);
    } catch {
      return null;
    }
  }

  isConfigured(key: IntegrationKey): boolean {
    switch (key) {
      case 'llm':
        return this.isDemo || this.secrets.has('llm.apiKey');
      case 'whmcs':
        return !!this.whmcs();
      case 'directadmin':
        return !!this.directadmin();
      case 'reseller':
        return !!this.reseller();
      case 'cloudflare':
        return !!this.cloudflare();
      case 'wordpress':
        return !!this.wordpress();
      case 'pagespeed':
        return this.settings.get().integrations.pagespeed.enabled;
      case 'storage':
        return !!this.storage();
      case 'mailbox':
        return !!this.mailbox();
      case 'anaf': {
        const e = this.settings.get().efactura;
        if (this.demo) return e.enabled;
        return !!e.cif && !!e.clientId && this.secrets.has('anaf.clientSecret') && this.secrets.has('anaf.refreshToken');
      }
      case 'gsc':
        return !!this.gsc() && !!this.settings.get().seo.property;
    }
  }

  isEnabled(key: IntegrationKey): boolean {
    const s = this.settings.get();
    switch (key) {
      case 'llm':
        return true;
      case 'storage':
        return s.backups.enabled;
      case 'mailbox':
        return s.email.enabled;
      case 'anaf':
        return s.efactura.enabled;
      case 'gsc':
        return s.seo.enabled;
      default:
        return s.integrations[key].enabled;
    }
  }

  statuses(): IntegrationStatusDTO[] {
    const keys: IntegrationKey[] = ['llm', 'whmcs', 'directadmin', 'cloudflare', 'wordpress', 'pagespeed', 'reseller', 'storage', 'mailbox', 'anaf', 'gsc'];
    return keys.map((key) => ({
      key,
      enabled: this.isEnabled(key),
      configured: this.isConfigured(key),
      ...this.settings.integrationTestStatus(key),
    }));
  }

  /** „Testează conexiunea” — întoarce un mesaj clar în română. */
  async test(key: IntegrationKey): Promise<{ ok: boolean; message: string }> {
    let result: { ok: boolean; message: string };
    try {
      result = { ok: true, message: await this.runTest(key) };
    } catch (err) {
      result = { ok: false, message: errorMessage(err) };
    }
    this.settings.recordIntegrationTest(key, result.ok, result.message);
    return result;
  }

  private async runTest(key: IntegrationKey): Promise<string> {
    switch (key) {
      case 'llm':
      case 'anaf':
      case 'gsc': {
        const tester = this.testers.get(key);
        if (!tester) throw new Error('Modulul nu e pornit.');
        return tester();
      }
      case 'storage': {
        const st = this.storage();
        if (!st) throw new Error('Completează adresa (endpoint), bucket-ul și cheile de acces, sau alege păstrarea pe serverul DAX.');
        return st.test();
      }
      case 'mailbox': {
        const m = this.mailbox();
        if (!m) throw new Error('Completează adresa căsuței, serverul IMAP și parola, apoi activează verificarea e-mailurilor.');
        return m.test();
      }
      case 'whmcs': {
        const c = this.whmcs();
        if (!c) throw new Error('Completează adresa WHMCS, API Identifier și API Secret, apoi activează integrarea.');
        const d = await c.details();
        const deps = await c.getDepartments();
        return `Conectat la WHMCS ${d.version}. Departamente de suport: ${deps.map((x) => x.name).join(', ') || 'niciunul'}.`;
      }
      case 'directadmin': {
        const c = this.directadmin();
        if (!c) throw new Error('Completează adresa panoului, utilizatorul și Login Key-ul, apoi activează integrarea.');
        await c.loginTest();
        const domains = await c.listDomains();
        let files = 'acces la fișiere: neverificat';
        try {
          await c.listFiles('/domains', { limit: 5 });
          files = 'acces la fișiere: OK';
        } catch (err) {
          files = `acces la fișiere: EȘUAT (${errorMessage(err)}) — adaugă permisiunile „filemanager” și „filemanager-actions” în Login Key`;
        }
        return `Conectat. Domenii: ${domains.join(', ') || 'niciunul'}; ${files}.`;
      }
      case 'reseller': {
        const c = this.reseller();
        if (!c) throw new Error('Completează datele contului de reseller și activează integrarea.');
        await c.loginTest();
        const users = await c.listUsers();
        return `Conectat la contul de reseller. Conturi de clienți: ${users.length}.`;
      }
      case 'cloudflare': {
        const c = this.cloudflare();
        if (!c) throw new Error('Completează zona (ex. datix.ro) și tokenul API, apoi activează integrarea.');
        const status = await c.verifyToken();
        const o = await c.zoneOverview();
        return `Token ${status}. Zona ${o.zone}: ${o.status}, plan ${o.plan ?? '?'}, nivel securitate „${o.securityLevel ?? '?'}”, SSL „${o.sslMode ?? '?'}”.`;
      }
      case 'wordpress': {
        const c = this.wordpress();
        if (!c) throw new Error('Activează integrarea și instalează pluginul DAX Connector cu secretul afișat în Setări.');
        const h = await c.health();
        return `Conectat la WordPress ${h.wp_version} (PHP ${h.php_version}), plugin conector ${h.connector_version}. Actualizări disponibile: ${h.updates.plugins} pluginuri, ${h.updates.themes} teme${h.updates.core ? `, nucleu ${h.updates.core}` : ''}.`;
      }
      case 'pagespeed': {
        const url = this.settings.get().sites.wordpressUrl;
        if (!url) throw new Error('Setează adresa site-ului WordPress.');
        const r = await this.net.pagespeed(url, 'mobile', this.pagespeedKey());
        return `PageSpeed funcționează: scor performanță mobil ${r.scores.performance ?? '?'}/100.`;
      }
    }
  }
}
