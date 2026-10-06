import { createHash, createHmac } from 'node:crypto';
import { IntegrationError } from './http';

// Client minimal pentru stocare compatibilă S3 (Cloudflare R2, Backblaze B2, AWS S3, Hetzner, MinIO),
// semnat cu AWS Signature V4. Fișierele mari se încarcă în bucăți (multipart) de mărime fixă —
// R2 cere ca toate bucățile, în afară de ultima, să aibă aceeași mărime.

const SERVICE = 'Stocare S3';
export const PART_SIZE = 16 * 1024 * 1024;

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  timeoutMs?: number;
}

export interface S3Object {
  key: string;
  sizeBytes: number;
  lastModified: number;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** Codare RFC 3986 (cea cerută de semnătura V4). */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key: string) => key.split('/').map(rfc3986).join('/');

const xmlValue = (xml: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;
const xmlDecode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export class S3Client {
  constructor(private readonly o: S3Options) {
    if (!o.endpoint || !o.bucket) throw new IntegrationError(SERVICE, 'completează adresa (endpoint) și bucket-ul.');
  }

  private url(key: string, query: Record<string, string> = {}): URL {
    const base = new URL(this.o.endpoint);
    const path = key ? `/${encodeKey(key)}` : '/';
    const url = this.o.pathStyle ? new URL(`${base.origin}/${this.o.bucket}${path}`) : new URL(`${base.protocol}//${this.o.bucket}.${base.host}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  /** Antetele semnate pentru o cerere (exportat pentru teste). */
  signedHeaders(method: string, url: URL, payloadHash: string, extra: Record<string, string> = {}, now = new Date()): Record<string, string> {
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])), host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
    const signed = names.join(';');
    const query = [...url.searchParams.entries()]
      .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonicalRequest = [method, url.pathname, query, canonicalHeaders, signed, payloadHash].join('\n');
    const region = this.o.region || 'auto';
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.o.secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    delete headers.host;
    return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${this.o.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
  }

  private async send(method: string, key: string, opts: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string>; okStatuses?: number[] } = {}): Promise<Response> {
    const url = this.url(key, opts.query);
    const body = opts.body ?? Buffer.alloc(0);
    const headers = this.signedHeaders(method, url, sha256(body), opts.headers ?? {});
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : new Uint8Array(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
      });
    } catch (err) {
      const e = err as Error;
      throw new IntegrationError(SERVICE, `${method} ${key || '/'}: ${e.name === 'TimeoutError' ? 'nu a răspuns în timp util' : `conexiune eșuată (${e.message})`}`, null, true);
    }
    if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) {
      const text = await res.text().catch(() => '');
      const code = xmlValue(text, 'Code');
      const message = xmlValue(text, 'Message');
      const hint =
        res.status === 403 || code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId'
          ? ' — verifică Access Key ID / Secret, regiunea și permisiunile cheii (citire + scriere pe bucket).'
          : code === 'NoSuchBucket'
            ? ' — bucket-ul nu există (verifică numele).'
            : '';
      throw new IntegrationError(SERVICE, `${method} ${key || '/'}: ${code ?? `HTTP ${res.status}`}${message ? ` (${xmlDecode(message)})` : ''}${hint}`, res.status);
    }
    return res;
  }

  async putObject(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await this.send('PUT', key, { body, headers: { 'content-type': contentType } });
  }

  async deleteObject(key: string): Promise<void> {
    await this.send('DELETE', key, { okStatuses: [404] });
  }

  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | null = null;
    for (let page = 0; page < 50; page++) {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const xml = await (await this.send('GET', '', { query })).text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const key = xmlValue(block, 'Key');
        if (!key) continue;
        out.push({ key: xmlDecode(key), sizeBytes: Number(xmlValue(block, 'Size') ?? 0), lastModified: Date.parse(xmlValue(block, 'LastModified') ?? '') || 0 });
      }
      token = xmlValue(xml, 'IsTruncated') === 'true' ? xmlValue(xml, 'NextContinuationToken') : null;
      if (!token) break;
    }
    return out;
  }

  /**
   * Încarcă un flux de date de mărime necunoscută: bucăți de PART_SIZE, multipart dacă depășește o bucată.
   * La eroare, încărcarea parțială e anulată (nu rămân bucăți plătite degeaba).
   */
  async upload(key: string, source: AsyncIterable<Buffer>, contentType = 'application/octet-stream', partSize = PART_SIZE): Promise<{ sizeBytes: number; parts: number }> {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let total = 0;
    let uploadId: string | null = null;
    const etags: string[] = [];

    const takePart = (size: number): Buffer => {
      const all = Buffer.concat(pending);
      const part = all.subarray(0, size);
      const rest = all.subarray(size);
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
      return Buffer.from(part);
    };
    const uploadPart = async (part: Buffer) => {
      if (!uploadId) {
        const xml = await (await this.send('POST', key, { query: { uploads: '' }, headers: { 'content-type': contentType } })).text();
        uploadId = xmlValue(xml, 'UploadId');
        if (!uploadId) throw new IntegrationError(SERVICE, 'serverul nu a pornit încărcarea în bucăți (lipsește UploadId).');
      }
      const res = await this.send('PUT', key, { query: { partNumber: String(etags.length + 1), uploadId }, body: part });
      const etag = res.headers.get('etag');
      if (!etag) throw new IntegrationError(SERVICE, `bucata ${etags.length + 1} nu a primit ETag.`);
      etags.push(etag);
    };

    try {
      for await (const chunk of source) {
        pending.push(chunk);
        pendingBytes += chunk.length;
        total += chunk.length;
        while (pendingBytes >= partSize * 2) await uploadPart(takePart(partSize));
      }
      if (!uploadId && pendingBytes <= partSize) {
        await this.putObject(key, takePart(pendingBytes), contentType);
        return { sizeBytes: total, parts: 1 };
      }
      while (pendingBytes > partSize) await uploadPart(takePart(partSize));
      if (pendingBytes > 0) await uploadPart(takePart(pendingBytes));
      const body = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const res = await this.send('POST', key, { query: { uploadId: uploadId! }, body: Buffer.from(body), headers: { 'content-type': 'application/xml' } });
      const text = await res.text();
      if (/<Error>/.test(text)) throw new IntegrationError(SERVICE, `finalizarea încărcării a eșuat: ${xmlValue(text, 'Message') ?? text.slice(0, 160)}`);
      return { sizeBytes: total, parts: etags.length };
    } catch (err) {
      if (uploadId) await this.send('DELETE', key, { query: { uploadId }, okStatuses: [404] }).catch(() => undefined);
      throw err;
    }
  }

  /** Test: scrie, listează și șterge un fișier mic. */
  async test(prefix: string): Promise<string> {
    const key = `${prefix}.dax-test-${Date.now()}`;
    await this.putObject(key, Buffer.from('DAX test'), 'text/plain');
    const listed = await this.list(prefix);
    await this.deleteObject(key);
    if (!listed.some((o) => o.key === key)) throw new IntegrationError(SERVICE, 'fișierul de test a fost scris, dar nu apare în listă (verifică prefixul).');
    const backups = listed.filter((o) => o.key !== key && /\.(tar\.(gz|zst)|enc)$/.test(o.key));
    return `Scriere, listare și ștergere OK în bucket-ul „${this.o.bucket}”. Copii existente: ${backups.length}.`;
  }
}
