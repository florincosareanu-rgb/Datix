import type { CloudflareApi, DirectAdminApi, WhmcsApi, WordPressApi } from '../integrations/types';
import type { WhmcsTicket, WhmcsTicketReply, WhmcsTicketSummary } from '../integrations/whmcs';
import type { DaFileEntry } from '../integrations/directadmin';
import type { CfDnsRecord, SecurityLevel } from '../integrations/cloudflare';
import type { WpHealth, WpPlugin } from '../integrations/wordpress';
import { IntegrationError } from '../integrations/http';
import { parseRescuePlugin, RESCUE_FILENAME } from '../integrations/wpRescue';
import { demoState, wpIsBroken } from './state';

const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
const dt = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000).toISOString().replace('T', ' ').slice(0, 19);

// =============================================================================== WHMCS

interface DemoTicket extends WhmcsTicket {}

function makeTickets(): DemoTicket[] {
  const t = (id: number, tid: string, userId: number, name: string, email: string, dept: [number, string], subject: string, status: string, replies: Array<Omit<WhmcsTicketReply, 'id'>>): DemoTicket => ({
    id,
    tid,
    deptId: dept[0],
    deptName: dept[1],
    userId,
    name,
    email,
    subject,
    status,
    priority: 'Medium',
    date: replies[0]?.date ?? dt(-60),
    lastReply: replies[replies.length - 1]?.date ?? dt(-60),
    flag: 0,
    serviceRef: null,
    replies: replies.map((r, i) => ({ ...r, id: String(id * 10 + i) })),
    notes: [],
  });
  return [
    t(101, '482913', 1, 'Andrei Popescu', 'andrei@popescudesign.ro', [1, 'Suport tehnic'], 'Nu îmi merg e-mailurile pe telefon', 'Open', [
      {
        author: 'Andrei Popescu',
        email: 'andrei@popescudesign.ro',
        isStaff: false,
        date: dt(-35),
        message:
          'Bună ziua,\n\nDe ieri nu mai pot trimite e-mailuri de pe iPhone (contul office@popescudesign.ro). Primesc mesajul „Serverul a respins expeditorul”. Pe calculator, în Outlook, merge. Ce pot face?\n\nMulțumesc,\nAndrei',
      },
    ]),
    t(102, '771204', 2, 'Maria Ionescu', 'maria.ionescu@cofetaria-maria.ro', [2, 'Facturare'], 'Mi s-au retras banii de două ori', 'Open', [
      {
        author: 'Maria Ionescu',
        email: 'maria.ionescu@cofetaria-maria.ro',
        isStaff: false,
        date: dt(-12),
        message:
          'Bună ziua, am primit două facturi pentru același pachet de hosting și mi s-a retras suma de două ori de pe card. Vă rog să-mi returnați banii cât mai repede. Este inacceptabil!',
      },
    ]),
    t(103, '339817', 3, 'Ion Vasilescu', 'ion@firma-ion.ro', [1, 'Suport tehnic'], 'Site-ul se încarcă foarte greu', 'Customer-Reply', [
      { author: 'Ion Vasilescu', email: 'ion@firma-ion.ro', isStaff: false, date: dt(-26 * 60), message: 'Site-ul firma-ion.ro se încarcă în 8-10 secunde de câteva zile. Puteți verifica?' },
      { author: 'Florin', email: '', isStaff: true, date: dt(-25 * 60), message: 'Bună ziua, verificăm și revenim cu detalii. Echipa Datix' },
      { author: 'Ion Vasilescu', email: 'ion@firma-ion.ro', isStaff: false, date: dt(-50), message: 'Aveți vreo noutate? Clienții mei se plâng că nu se deschide pagina de produse.' },
    ]),
  ];
}

export class DemoWhmcs implements WhmcsApi {
  private tickets = makeTickets();

  async call<T>(action: string): Promise<T> {
    throw new IntegrationError('WHMCS', `Acțiunea ${action} nu e disponibilă în modul demo.`);
  }

  async details() {
    return { version: '8.13.1' };
  }

  private summary(t: DemoTicket): WhmcsTicketSummary {
    const { replies: _r, notes: _n, serviceRef: _s, ...rest } = t;
    return rest;
  }

  async getTickets(params: { status?: string; limitnum?: number } = {}) {
    const list = this.tickets.filter((t) => !params.status || t.status === params.status);
    return { total: list.length, tickets: list.slice(0, params.limitnum ?? 50).map((t) => this.summary(t)) };
  }

  async getAwaitingTickets() {
    return this.tickets.filter((t) => t.status === 'Open' || t.status === 'Customer-Reply').map((t) => this.summary(t));
  }

  async getTicket(ticketId: number): Promise<WhmcsTicket> {
    const t = this.tickets.find((x) => x.id === ticketId);
    if (!t) throw new IntegrationError('WHMCS', `GetTicket: Ticket ID Not Found`);
    return structuredClone(t);
  }

  async addTicketReply(params: { ticketId: number; message: string; adminUsername?: string; status?: string }) {
    const t = this.tickets.find((x) => x.id === params.ticketId);
    if (!t) throw new IntegrationError('WHMCS', 'Ticket ID Not Found');
    const date = dt(0);
    t.replies.push({ id: String(Date.now()), author: params.adminUsername || 'Echipa Datix', email: '', isStaff: true, date, message: params.message });
    t.status = params.status ?? 'Answered';
    t.lastReply = date;
  }

  async addTicketNote(params: { ticketId: number; message: string }) {
    const t = this.tickets.find((x) => x.id === params.ticketId);
    t?.notes.push({ admin: 'DAX', date: dt(0), message: params.message });
  }

  async updateTicket(params: { ticketId: number; status?: string; priority?: string }) {
    const t = this.tickets.find((x) => x.id === params.ticketId);
    if (t && params.status) t.status = params.status;
    if (t && params.priority) t.priority = params.priority;
  }

  async getDepartments() {
    return [
      { id: 1, name: 'Suport tehnic', awaitingReply: 2, open: 2 },
      { id: 2, name: 'Facturare', awaitingReply: 1, open: 1 },
      { id: 3, name: 'Vânzări', awaitingReply: 0, open: 0 },
    ];
  }

  private clients = [
    { id: 1, name: 'Andrei Popescu', company: 'Popescu Design SRL', email: 'andrei@popescudesign.ro', domain: 'popescudesign.ro', product: 'Hosting Standard' },
    { id: 2, name: 'Maria Ionescu', company: 'Cofetăria Maria', email: 'maria.ionescu@cofetaria-maria.ro', domain: 'cofetaria-maria.ro', product: 'Hosting Start' },
    { id: 3, name: 'Ion Vasilescu', company: 'Firma Ion SRL', email: 'ion@firma-ion.ro', domain: 'firma-ion.ro', product: 'Hosting Business + mentenanță WordPress' },
  ];

  async getClient(clientId: number) {
    const c = this.clients.find((x) => x.id === clientId);
    if (!c) throw new IntegrationError('WHMCS', 'Client Not Found');
    return {
      id: c.id,
      name: c.name,
      company: c.company,
      email: c.email,
      status: 'Active',
      country: 'RO',
      language: 'romanian',
      createdAt: iso(-400),
      lastLogin: dt(-3000),
      credit: '0.00',
      currency: 'RON',
      notes: null,
      stats: { activeServices: 1, totalServices: 1, unpaidInvoices: c.id === 2 ? 1 : 0, unpaidAmount: c.id === 2 ? '149.00 RON' : '0.00 RON', overdueInvoices: 0, overdueAmount: '0.00 RON', activeDomains: 1, openTickets: 1 },
    };
  }

  async findClientByEmail(email: string) {
    return this.clients.find((c) => c.email === email.toLowerCase())?.id ?? null;
  }

  async getClientProducts(clientId?: number) {
    const list = this.clients.filter((c) => !clientId || c.id === clientId);
    return {
      total: list.length,
      products: list.map((c) => ({
        id: 500 + c.id,
        clientId: c.id,
        name: c.product,
        group: 'Găzduire web',
        domain: c.domain,
        status: 'Active',
        billingCycle: 'Annually',
        recurringAmount: c.id === 3 ? '1490.00' : '149.00',
        nextDueDate: iso(120 + c.id * 30),
        regDate: iso(-400),
        server: 'srv1.furnizor.ro',
        serverHostname: 'srv1.furnizor.ro',
        serverIp: '203.0.113.20',
        module: 'directadmin',
        username: c.domain.split('.')[0]!.slice(0, 8),
        diskUsageMb: 1200 * c.id,
        diskLimitMb: 5000,
        bwUsageMb: 3000 * c.id,
        bwLimitMb: 50000,
        suspensionReason: null,
      })),
    };
  }

  async getClientDomains(clientId?: number) {
    const list = this.clients.filter((c) => !clientId || c.id === clientId);
    return {
      total: list.length,
      domains: list.map((c) => ({
        id: 900 + c.id,
        clientId: c.id,
        domain: c.domain,
        status: 'Active',
        registrar: 'rotld',
        expiryDate: iso(c.id === 2 ? 12 : 40 + c.id * 50),
        nextDueDate: iso(c.id === 2 ? 12 : 40 + c.id * 50),
        doNotRenew: false,
        recurringAmount: '59.00',
      })),
    };
  }

  async getInvoices(params: { status?: string; userid?: number } = {}) {
    const all = [
      { id: 7001, number: 'DTX-2026-0412', clientId: 2, clientName: 'Maria Ionescu', date: iso(-20), dueDate: iso(-6), total: 149, balance: 149, status: 'Overdue', currencyPrefix: '', currencySuffix: ' RON' },
      { id: 7002, number: 'DTX-2026-0431', clientId: 1, clientName: 'Andrei Popescu', date: iso(-5), dueDate: iso(9), total: 349, balance: 349, status: 'Unpaid', currencyPrefix: '', currencySuffix: ' RON' },
      { id: 7003, number: 'DTX-2026-0433', clientId: 3, clientName: 'Ion Vasilescu', date: iso(-3), dueDate: iso(11), total: 1490, balance: 1490, status: 'Unpaid', currencyPrefix: '', currencySuffix: ' RON' },
    ];
    const list = all.filter((i) => (!params.userid || i.clientId === params.userid) && (!params.status || i.status === params.status || (params.status === 'Unpaid' && i.status === 'Overdue')));
    return { total: list.length, invoices: list };
  }

  async getOrders() {
    return {
      total: 3,
      orders: [
        { id: 3301, number: '8812734', clientId: 3, clientName: 'Ion Vasilescu', date: dt(-120), amount: 1490, status: 'Pending', paymentStatus: 'Unpaid', paymentMethod: 'Card' },
        { id: 3300, number: '8812701', clientId: 1, clientName: 'Andrei Popescu', date: dt(-3 * 1440), amount: 59, status: 'Active', paymentStatus: 'Paid', paymentMethod: 'Transfer bancar' },
        { id: 3299, number: '8812655', clientId: 2, clientName: 'Maria Ionescu', date: dt(-9 * 1440), amount: 149, status: 'Active', paymentStatus: 'Paid', paymentMethod: 'Card' },
      ],
    };
  }

  async getStats(timelineDays = 30) {
    const timeline = Array.from({ length: timelineDays }, (_, i) => {
      const d = new Date(Date.now() - (timelineDays - 1 - i) * day);
      const seed = (d.getDate() * 37) % 11;
      return { date: d.toISOString().slice(0, 10), income: seed > 6 ? 149 * (seed - 5) : seed > 3 ? 59 : 0, newOrders: seed > 6 ? 2 : seed > 3 ? 1 : 0, newTickets: seed % 3 };
    });
    return {
      incomeToday: 249.99,
      incomeThisMonth: 4820.5,
      incomeThisYear: 38450,
      ordersPending: 1,
      ordersToday: 1,
      ordersThisMonth: 14,
      ticketsAwaitingReply: this.tickets.filter((t) => t.status === 'Open' || t.status === 'Customer-Reply').length,
      ticketsOpen: this.tickets.filter((t) => t.status !== 'Closed').length,
      cancellationsPending: 1,
      currencyHint: 'RON',
      timeline,
    };
  }

  async getActivityLog() {
    return [
      { id: 1, date: dt(-30), description: 'Admin Login - Username: florin', user: 'florin', ip: '86.120.10.20', clientId: 0 },
      { id: 2, date: dt(-200), description: 'Failed Admin Login Attempt - Username: admin', user: 'System', ip: '45.155.205.12', clientId: 0 },
      { id: 3, date: dt(-400), description: 'Cron Job: Completed', user: 'System', ip: null, clientId: 0 },
    ];
  }

  async getAdminUsers() {
    return [{ id: 1, username: 'florin', name: 'Florin', email: 'contact@datix.ro', role: '1', disabled: false }];
  }
}

// =============================================================================== DirectAdmin

const WP = '/domains/datix.ro/public_html';

function initialFiles(): Map<string, Buffer> {
  const f = new Map<string, Buffer>();
  const put = (p: string, c: string) => f.set(p, Buffer.from(c, 'utf8'));
  put(`${WP}/.htaccess`, '# BEGIN WordPress\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteBase /\nRewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n</IfModule>\n# END WordPress\n');
  put(
    `${WP}/wp-config.php`,
    "<?php\ndefine( 'DB_NAME', 'datix_wp' );\ndefine( 'DB_USER', 'datix_wpuser' );\ndefine( 'DB_PASSWORD', 'Sup3rS3cret!Demo' );\ndefine( 'DB_HOST', 'localhost' );\ndefine( 'AUTH_KEY', 'demo-auth-key-abcdef' );\n$table_prefix = 'wp_';\ndefine( 'WP_DEBUG', false );\nrequire_once ABSPATH . 'wp-settings.php';\n",
  );
  put(`${WP}/error_log`, `[${new Date(Date.now() - 2 * day).toUTCString()}] PHP Warning:  Undefined array key "lang" in ${WP}/wp-content/themes/astra/inc/core/class-astra.php on line 112\n`);
  put(`${WP}/wp-content/plugins/elementor/elementor.php`, '<?php /* Elementor (demo) */');
  put(`${WP}/wp-content/plugins/contact-form-7/wp-contact-form-7.php`, '<?php /* CF7 (demo) */');
  put(`${WP}/wp-content/plugins/litespeed-cache/litespeed-cache.php`, '<?php /* LSCache (demo) */');
  put(`${WP}/wp-content/themes/astra/style.css`, '/* Astra */');
  put(`${WP}/wp-content/themes/twentytwentyfive/style.css`, '/* Twenty Twenty-Five */');
  put('/domains/my.datix.ro/public_html/configuration.php', "<?php\n$license = 'WHMCS-DEMO-XXXX';\n$db_host = 'localhost';\n$db_username = 'datix_whmcs';\n$db_password = 'AltaParolaDemo!';\n$db_name = 'datix_whmcs';\n$cc_encryption_hash = 'demohash';\n");
  put('/backups/backup-Sep.28.2026-03.00.datix.tar.gz', 'BINARY\u0000demo');
  return f;
}

export class DemoDirectAdmin implements DirectAdminApi {
  readonly label = 'DirectAdmin (demo)';
  private files = initialFiles();

  asUser(_user: string): DirectAdminApi {
    return this;
  }

  async request<T>(path: string): Promise<T> {
    throw new IntegrationError('DirectAdmin', `${path} nu e disponibil în modul demo.`);
  }

  async session() {
    return { username: 'datix', level: 'user' };
  }

  async listFiles(path: string) {
    const prefix = path.replace(/\/+$/, '') + '/';
    const entries = new Map<string, DaFileEntry>();
    for (const [p, c] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const [name, ...more] = rest.split('/');
      if (!name) continue;
      if (more.length) entries.set(name, { name, type: 'dir', sizeBytes: 4096, mode: '755', modified: new Date().toISOString() });
      else entries.set(name, { name, type: 'file', sizeBytes: c.length, mode: '644', modified: new Date(Date.now() - day).toISOString() });
    }
    if (!entries.size && ![...this.files.keys()].some((k) => k.startsWith(prefix))) throw new IntegrationError('DirectAdmin', `director inexistent: ${path}`, 404);
    return { path, total: entries.size, files: [...entries.values()] };
  }

  private errorLogFor(path: string): Buffer | null {
    if (!/\/wp-content\/dax-errors-[a-f0-9]+\.log$/.test(path)) return null;
    if (!demoState.wpFault) return Buffer.from('');
    return Buffer.from(
      `[${new Date().toUTCString()}] PHP Fatal error:  Uncaught Error: Call to undefined function Elementor\\get_kit_settings() in ${WP}/wp-content/plugins/elementor/includes/frontend.php:1312\n[DAX-FATAL] Uncaught Error: Call to undefined function Elementor\\get_kit_settings() in ${WP}/wp-content/plugins/elementor/includes/frontend.php:1312 URI=/\n`,
    );
  }

  async downloadFile(path: string) {
    const dynamic = this.errorLogFor(path);
    if (dynamic) return dynamic;
    const f = this.files.get(path);
    if (!f) throw new IntegrationError('DirectAdmin', `fișierul nu există: ${path}`, 404);
    return f;
  }

  async readText(path: string, maxBytes = 256 * 1024) {
    const bytes = await this.downloadFile(path);
    const binary = bytes.includes(0);
    return { path, sizeBytes: bytes.length, truncated: bytes.length > maxBytes, binary, content: binary ? '' : bytes.subarray(-maxBytes).toString('utf8') };
  }

  async uploadFile(path: string, content: string | Buffer) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    this.files.set(path, data);
    if (path.endsWith(`/mu-plugins/${RESCUE_FILENAME}`)) {
      const cfg = parseRescuePlugin(data.toString('utf8'));
      demoState.rescueDisabled = new Set(cfg?.disabled_plugins ?? []);
      demoState.maintenance = !!cfg?.maintenance;
    }
    return { verified: true, sizeBytes: data.length };
  }

  async mkdir(path: string) {
    this.files.set(`${path}/.keep`, Buffer.from(''));
  }

  async trash(paths: string[]) {
    for (const p of paths) {
      for (const k of [...this.files.keys()]) if (k === p || k.startsWith(`${p}/`)) this.files.delete(k);
      if (p.endsWith(`/mu-plugins/${RESCUE_FILENAME}`)) demoState.rescueDisabled.clear();
    }
  }

  async exists(path: string) {
    return this.files.has(path) || [...this.files.keys()].some((k) => k.startsWith(`${path}/`));
  }

  async searchFiles(path: string, query: string) {
    const q = query.replace(/\*/g, '').toLowerCase();
    return [...this.files.keys()].filter((k) => k.startsWith(path) && k.toLowerCase().includes(q)).slice(0, 50);
  }

  async searchText(path: string, query: string) {
    return [...this.files.entries()].filter(([k, v]) => k.startsWith(path) && v.toString('utf8').includes(query)).map(([k]) => ({ path: k }));
  }

  async legacy(command: string) {
    return { result: `${command} (demo)` };
  }

  async loginTest() {
    return true;
  }

  async listDomains() {
    return ['datix.ro', 'my.datix.ro'];
  }

  async userConfig() {
    return { ip: '203.0.113.10', package: 'Business', suspended: 'no' };
  }

  async usage() {
    return {
      diskMb: 3120,
      diskLimitMb: 5120,
      diskPct: 60.9,
      bandwidthMb: 12_400,
      bandwidthLimitMb: 100_000,
      bandwidthPct: 12.4,
      inodes: 48_200,
      inodeLimit: 150_000,
      inodePct: 32.1,
      emailAccounts: 4,
      databases: 2,
      domains: 2,
      ip: '203.0.113.10',
      package: 'Business',
      suspended: false,
      php: 'ON',
      raw: { usage: {}, config: {} },
    };
  }

  async listDatabases() {
    return ['datix_wp', 'datix_whmcs'];
  }

  async listEmailAccounts() {
    return ['contact', 'office', 'facturare', 'suport'];
  }

  async dnsRecords() {
    return [];
  }

  async requestLetsEncrypt(domain: string) {
    return { result: `Certificat Let's Encrypt emis pentru ${domain} (demo).` };
  }

  async createBackup() {
    this.files.set(`/backups/backup-${new Date().toISOString().slice(0, 10)}.datix.tar.gz`, Buffer.from('BINARY\u0000demo'));
    return { result: 'Backup pornit (demo).' };
  }

  async listBackups() {
    return [...this.files.entries()]
      .filter(([k]) => k.startsWith('/backups/'))
      .map(([k, v]) => ({ name: k.slice(9), type: 'file', sizeBytes: v.length, mode: '600', modified: new Date().toISOString() }));
  }

  async restoreBackup(file: string) {
    return { result: `Restaurarea din ${file} a pornit (demo).` };
  }

  async listUsers() {
    return ['popescu1', 'cofetari', 'firmaion'];
  }

  async userDomains(user: string) {
    return [{ popescu1: 'popescudesign.ro', cofetari: 'cofetaria-maria.ro', firmaion: 'firma-ion.ro' }[user] ?? `${user}.ro`];
  }

  async setSuspended(user: string, suspended: boolean) {
    return { result: `${user} ${suspended ? 'suspendat' : 'reactivat'} (demo)` };
  }
}

// =============================================================================== Cloudflare

export class DemoCloudflare implements CloudflareApi {
  private records: CfDnsRecord[] = [
    { id: 'r1', type: 'A', name: 'datix.ro', content: '203.0.113.10', proxied: true, ttl: 1 },
    { id: 'r2', type: 'CNAME', name: 'www.datix.ro', content: 'datix.ro', proxied: true, ttl: 1 },
    { id: 'r3', type: 'A', name: 'my.datix.ro', content: '203.0.113.10', proxied: true, ttl: 1 },
    { id: 'r4', type: 'A', name: 'mail.datix.ro', content: '203.0.113.10', proxied: false, ttl: 1 },
    { id: 'r5', type: 'MX', name: 'datix.ro', content: 'mail.datix.ro', proxied: false, ttl: 1, priority: 10 },
    { id: 'r6', type: 'TXT', name: 'datix.ro', content: 'v=spf1 a mx include:_spf.datix.ro ~all', proxied: false, ttl: 1 },
  ];

  async verifyToken() {
    return 'active';
  }
  async zoneId() {
    return 'demo-zone-id';
  }
  async zoneOverview() {
    return {
      zone: 'datix.ro',
      status: 'active',
      paused: false,
      plan: 'Free Website',
      nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
      securityLevel: demoState.securityLevel,
      sslMode: 'full',
      developmentMode: 'off',
      alwaysUseHttps: 'on',
    };
  }
  async getSetting<T>(name: string): Promise<T> {
    return (name === 'security_level' ? demoState.securityLevel : 'off') as T;
  }
  async setSetting<T>(name: string, value: T): Promise<T> {
    if (name === 'security_level') demoState.securityLevel = String(value);
    return value;
  }
  async setSecurityLevel(level: SecurityLevel) {
    demoState.securityLevel = level;
    return level;
  }
  async setDevelopmentMode(on: boolean) {
    return on ? 'on' : 'off';
  }
  async purgeCache() {}
  async dnsRecords() {
    return this.records;
  }
  async createDnsRecord(rec: { type: string; name: string; content: string; proxied?: boolean; priority?: number }) {
    const r: CfDnsRecord = { id: `r${Date.now()}`, ttl: 1, ...rec };
    this.records.push(r);
    return r;
  }
  async updateDnsRecord(recordId: string, rec: { type: string; name: string; content: string; proxied?: boolean }) {
    const i = this.records.findIndex((r) => r.id === recordId);
    if (i < 0) throw new IntegrationError('Cloudflare', 'Înregistrare inexistentă.');
    this.records[i] = { ...this.records[i]!, ...rec };
    return this.records[i]!;
  }
  async deleteDnsRecord(recordId: string) {
    this.records = this.records.filter((r) => r.id !== recordId);
  }
  async securityEvents(hours = 24) {
    const total = Math.round(40 * hours + Math.random() * 30);
    return {
      hours,
      total,
      byAction: [
        { action: 'managed_challenge', source: 'securitylevel', count: Math.round(total * 0.6) },
        { action: 'block', source: 'firewallManaged', count: Math.round(total * 0.4) },
      ],
      topCountries: [
        { country: 'CN', count: Math.round(total * 0.3) },
        { country: 'US', count: Math.round(total * 0.2) },
        { country: 'RU', count: Math.round(total * 0.15) },
      ],
      topIps: [
        { ip: '45.155.205.12', count: Math.round(total * 0.1) },
        { ip: '193.32.162.7', count: Math.round(total * 0.06) },
      ],
      recent: [{ at: new Date().toISOString(), action: 'block', source: 'firewallManaged', ip: '45.155.205.12', country: 'RU', method: 'POST', path: '/xmlrpc.php' }],
    };
  }
}

// =============================================================================== WordPress

export class DemoWordPress implements WordPressApi {
  private pluginList: WpPlugin[] = [
    { file: 'elementor/elementor.php', slug: 'elementor', name: 'Elementor', version: '3.25.4', active: true, update: '3.25.9', auto_update: false },
    { file: 'contact-form-7/wp-contact-form-7.php', slug: 'contact-form-7', name: 'Contact Form 7', version: '5.9.2', active: true, update: '6.0.1', auto_update: false },
    { file: 'litespeed-cache/litespeed-cache.php', slug: 'litespeed-cache', name: 'LiteSpeed Cache', version: '7.0', active: true, update: null, auto_update: true },
    { file: 'wordpress-seo/wp-seo.php', slug: 'wordpress-seo', name: 'Yoast SEO', version: '24.1', active: true, update: null, auto_update: true },
    { file: 'akismet/akismet.php', slug: 'akismet', name: 'Akismet Anti-spam', version: '5.3.5', active: false, update: null, auto_update: false },
    { file: 'dax-connector/dax-connector.php', slug: 'dax-connector', name: 'DAX Connector', version: '1.0.0', active: true, update: null, auto_update: false },
  ];

  private ensureUp() {
    if (wpIsBroken()) throw new IntegrationError('WordPress', 'răspuns invalid (HTTP 500). Site-ul WordPress pare să aibă o eroare.', 500);
  }

  async call<T>(endpoint: string): Promise<T> {
    throw new IntegrationError('WordPress', `${endpoint} nu e disponibil în modul demo.`);
  }

  async health(): Promise<WpHealth> {
    this.ensureUp();
    return {
      wp_version: '6.8.3',
      php_version: '8.2.28',
      db_version: '10.6.21-MariaDB',
      site_url: 'https://datix.ro',
      home_url: 'https://datix.ro',
      multisite: false,
      theme: { name: 'Astra', version: '4.8.1', stylesheet: 'astra', update: null },
      plugins_total: this.pluginList.length,
      plugins_active: this.pluginList.filter((p) => p.active).length,
      updates: { core: null, plugins: this.pluginList.filter((p) => p.update).length, themes: 0, translations: 1 },
      flags: { debug: false, debug_display: false, debug_log: false, file_edit: true, xmlrpc: true, user_enum_blocked: false, force_ssl_admin: true },
      debug_log_bytes: null,
      cron: { disabled: false, overdue: 0 },
      memory_limit: '256M',
      cache_plugins: ['LiteSpeed Cache'],
      maintenance: demoState.maintenance,
      connector_version: '1.0.0',
    };
  }

  async plugins() {
    this.ensureUp();
    return this.pluginList;
  }

  async togglePlugin(plugin: string, active: boolean) {
    this.ensureUp();
    const p = this.pluginList.find((x) => x.file === plugin);
    if (!p) throw new IntegrationError('WordPress', `Pluginul ${plugin} nu există.`);
    p.active = active;
    return { plugin, active };
  }

  async runUpdates(type: 'plugin' | 'theme' | 'core' | 'translations', items: string[] = []) {
    this.ensureUp();
    const targets = type === 'plugin' ? this.pluginList.filter((p) => p.update && (!items.length || items.includes(p.file))) : [];
    const results = targets.map((p) => {
      const from = p.version;
      p.version = p.update!;
      p.update = null;
      return { item: p.file, ok: true, message: 'Actualizat', from, to: p.version };
    });
    return { results: results.length ? results : [{ item: type, ok: true, message: 'Nimic de actualizat' }] };
  }

  async securityAudit() {
    this.ensureUp();
    return {
      core_checksums: { ok: true, modified: [], unknown: [] },
      php_in_uploads: [],
      recently_modified_php: [{ path: 'wp-content/plugins/contact-form-7/includes/submission.php', modified: iso(-2) }],
      admins: [{ login: 'florin', email: 'contact@datix.ro', registered: '2024-03-02' }],
      risky_settings: { file_edit_enabled: true, xmlrpc_enabled: true, default_admin_username: false, debug_display: false },
      suspicious_code: [],
    };
  }

  async securityEvents() {
    this.ensureUp();
    const now = Math.floor(Date.now() / 1000);
    return [
      { id: 3, at: now - 600, type: 'login_failed', user: 'admin', ip: '45.155.205.12', details: null },
      { id: 2, at: now - 900, type: 'login_failed', user: 'admin', ip: '45.155.205.12', details: null },
      { id: 1, at: now - 7200, type: 'login_success', user: 'florin', ip: '86.120.10.20', details: 'administrator' },
    ];
  }

  async admins() {
    this.ensureUp();
    return [{ id: 1, login: 'florin', email: 'contact@datix.ro', registered: '2024-03-02 10:00:00', last_login: Math.floor(Date.now() / 1000) - 7200 }];
  }

  async setMaintenance(enabled: boolean) {
    demoState.maintenance = enabled;
    return { enabled };
  }

  async purgeCache() {
    this.ensureUp();
    return { purged: ['LiteSpeed Cache', 'object-cache'] };
  }

  async debugLog() {
    this.ensureUp();
    return { path: null, bytes: 0, content: '' };
  }

  async hardening(opts: { disable_xmlrpc?: boolean; block_user_enum?: boolean; disable_file_edit?: boolean }) {
    this.ensureUp();
    return { disable_xmlrpc: !!opts.disable_xmlrpc, block_user_enum: !!opts.block_user_enum, disable_file_edit: !!opts.disable_file_edit };
  }
}
