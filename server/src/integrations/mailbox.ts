import { ImapFlow, type MessageStructureObject } from 'imapflow';
import { IntegrationError } from './http';

// Căsuța de monitorizare (IMAP): aici sosesc e-mailurile de test trimise prin WHMCS și rapoartele DMARC.

const SERVICE = 'Căsuța de monitorizare';
export const DMARC_FOLDER = 'DAX-DMARC';

export interface MailboxOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  timeoutMs?: number;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

async function streamToBuffer(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > max) throw new IntegrationError(SERVICE, 'atașament prea mare');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function attachmentParts(node: MessageStructureObject | undefined, out: MessageStructureObject[] = []): MessageStructureObject[] {
  if (!node) return out;
  if (node.childNodes?.length) {
    for (const c of node.childNodes) attachmentParts(c, out);
    return out;
  }
  const type = node.type.toLowerCase();
  const name = (node.dispositionParameters?.filename ?? node.parameters?.name ?? '').toLowerCase();
  if (/zip|gzip|x-gzip|xml|octet-stream/.test(type) || /\.(zip|gz|xml)$/.test(name)) out.push(node);
  return out;
}

export class MailboxClient {
  constructor(private readonly o: MailboxOptions) {
    if (!o.host || !o.user || !o.password) throw new IntegrationError(SERVICE, 'completează serverul IMAP, adresa și parola.');
  }

  private async withClient<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.o.host,
      port: this.o.port,
      secure: this.o.port === 993,
      auth: { user: this.o.user, pass: this.o.password },
      logger: false,
      connectionTimeout: this.o.timeoutMs ?? 30_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (err) {
      const e = err as Error & { authenticationFailed?: boolean; code?: string };
      if (e.authenticationFailed) throw new IntegrationError(SERVICE, 'autentificare eșuată — verifică adresa și parola căsuței.');
      if (/certificate|self.signed|altname/i.test(e.message)) {
        throw new IntegrationError(SERVICE, `certificatul serverului ${this.o.host} nu e valid pentru acest nume. Folosește numele serverului de e-mail din DirectAdmin (ex. numele serverului de hosting).`);
      }
      throw new IntegrationError(SERVICE, `nu mă pot conecta la ${this.o.host}:${this.o.port} (${e.code ?? e.message}).`, null, true);
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async test(): Promise<string> {
    return this.withClient(async (c) => {
      const st = await c.status('INBOX', { messages: true, unseen: true });
      if (!st) return `Conectat la ${this.o.user}.`;
      return `Conectat la ${this.o.user}: ${st.messages ?? 0} mesaje în Inbox (${st.unseen ?? 0} necitite).`;
    });
  }

  /** Caută în Inbox mesajul de test după codul unic din subiect; întoarce data primirii (dacă a sosit). */
  async findBySubject(token: string): Promise<{ uid: number; receivedAt: number; authResults: string | null } | null> {
    return this.withClient(async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const uids = await c.search({ subject: token }, { uid: true });
        if (!uids || !uids.length) return null;
        const uid = uids[uids.length - 1]!;
        const msg = await c.fetchOne(String(uid), { internalDate: true, headers: ['authentication-results'] }, { uid: true });
        if (!msg) return null;
        const headers = msg.headers?.toString('utf8') ?? '';
        const auth = /authentication-results:\s*([\s\S]*?)(?:\r?\n(?!\s)|$)/i.exec(headers)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
        const date = msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now();
        return { uid, receivedAt: date, authResults: auth };
      } finally {
        lock.release();
      }
    });
  }

  /** Șterge mesajele de test vechi (subiect cu prefixul dat). */
  async deleteBySubject(prefix: string): Promise<number> {
    return this.withClient(async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const uids = await c.search({ subject: prefix }, { uid: true });
        if (!uids || !uids.length) return 0;
        await c.messageDelete(uids.join(','), { uid: true });
        return uids.length;
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Rapoartele DMARC din Inbox (atașamente .zip / .gz / .xml). După citire, mesajele sunt mutate
   * în dosarul DAX-DMARC, ca să nu fie procesate de două ori.
   */
  async takeDmarcReports(limit = 50): Promise<Array<{ uid: number; subject: string; attachments: MailAttachment[] }>> {
    return this.withClient(async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      const out: Array<{ uid: number; subject: string; attachments: MailAttachment[] }> = [];
      try {
        const found = await c.search({ or: [{ subject: 'Report Domain' }, { subject: 'DMARC' }, { subject: 'Report domain' }] }, { uid: true });
        const uids = (found || []).slice(-limit);
        for (const uid of uids) {
          const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true }, { uid: true });
          if (!msg) continue;
          const attachments: MailAttachment[] = [];
          for (const part of attachmentParts(msg.bodyStructure)) {
            if (!part.part) continue;
            const dl = await c.download(String(uid), part.part, { uid: true });
            if (!('content' in dl) || !dl.content) continue;
            attachments.push({
              filename: part.dispositionParameters?.filename ?? part.parameters?.name ?? `parte-${part.part}`,
              contentType: part.type,
              content: await streamToBuffer(dl.content, 20 * 1024 * 1024),
            });
          }
          out.push({ uid, subject: msg.envelope?.subject ?? '', attachments });
        }
        if (out.length) {
          await c.mailboxCreate(DMARC_FOLDER).catch(() => undefined);
          await c.messageMove(out.map((m) => m.uid).join(','), DMARC_FOLDER, { uid: true });
        }
        return out;
      } finally {
        lock.release();
      }
    });
  }
}
