import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createZip } from '../src/util/zip';
import { buildPluginZip, phpString, pluginConfigPhp, whmcsHookPhp } from '../src/http/routes/downloads';
import { defaultRescueConfig, parseRescuePlugin, renderRescuePlugin } from '../src/integrations/wpRescue';

const hasPhp = spawnSync('php', ['-v']).status === 0;
const repo = fileURLToPath(new URL('../../', import.meta.url));

/** Cititor ZIP minimal (directorul central) — verifică arhiva fără unelte externe. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (!name.endsWith('/')) expect(crc32(data) >>> 0).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('arhiva ZIP', () => {
  it('se poate citi înapoi, cu conținut și CRC corecte', () => {
    const big = Buffer.from('a'.repeat(5000) + 'ăîșțâ');
    const zip = createZip([{ name: 'd/' }, { name: 'd/a.txt', data: Buffer.from('salut') }, { name: 'd/big.txt', data: big }, { name: 'gol.txt', data: Buffer.alloc(0) }]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['d/', 'd/a.txt', 'd/big.txt', 'gol.txt']);
    expect(files.get('d/a.txt')!.toString()).toBe('salut');
    expect(files.get('d/big.txt')!.equals(big)).toBe(true);
  });

  it.skipIf(spawnSync('unzip', ['-v']).status !== 0)('e validă și pentru unzip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    try {
      writeFileSync(join(dir, 'x.zip'), createZip([{ name: 'p/' }, { name: 'p/f.php', data: Buffer.from('<?php echo 1;') }]));
      expect(execFileSync('unzip', ['-t', join(dir, 'x.zip')], { encoding: 'utf8' })).toContain('No errors detected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pluginul WordPress descărcabil', () => {
  const secret = "s3cr3t'cu\\caractere";
  const zip = buildPluginZip(join(repo, 'integrations'), secret, 'https://dax.datix.ro');
  const files = readZip(zip);

  it('conține pluginul complet și config.php cu cheia', () => {
    expect(files.has('dax-connector/dax-connector.php')).toBe(true);
    expect(files.has('dax-connector/includes/class-dax-auth.php')).toBe(true);
    expect(files.has('dax-connector/uninstall.php')).toBe(true);
    const config = files.get('dax-connector/config.php')!.toString();
    expect(config).toContain(`define('DAX_SECRET', ${phpString(secret)});`);
    expect(config).toContain("define('DAX_AGENT_URL', 'https://dax.datix.ro');");
  });

  it.skipIf(!hasPhp)('config.php e PHP valid și definește exact valorile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      const file = join(dir, 'config.php');
      writeFileSync(file, pluginConfigPhp(secret, 'https://dax.datix.ro'));
      const out = execFileSync('php', ['-r', `define('ABSPATH', '/'); require '${file}'; echo json_encode([DAX_SECRET, DAX_AGENT_URL]);`], { encoding: 'utf8' });
      expect(JSON.parse(out)).toEqual([secret, 'https://dax.datix.ro']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hook-ul WHMCS descărcabil', () => {
  const template = readFileSync(join(repo, 'integrations/whmcs/dax.php'), 'utf8');

  it('completează adresa și cheia', () => {
    const php = whmcsHookPhp(template, 'abc123secretabc123', 'https://dax.datix.ro');
    expect(php).toContain("define('DAX_URL', 'https://dax.datix.ro');");
    expect(php).toContain("define('DAX_SECRET', 'abc123secretabc123');");
    expect(php).not.toContain('%%DAX_');
  });

  it('refuză un șablon modificat', () => {
    expect(() => whmcsHookPhp('<?php // gol', 'x', 'y')).toThrow();
  });
});

describe('trusa de salvare WordPress (mu-plugin)', () => {
  it('configurația se poate citi înapoi din fișier', () => {
    const cfg = { ...defaultRescueConfig(), disabled_plugins: ['elementor'], capture_errors: true };
    expect(parseRescuePlugin(renderRescuePlugin(cfg))).toEqual(cfg);
    expect(parseRescuePlugin('<?php // alt fișier')).toBeNull();
  });

  it.skipIf(!hasPhp)('fișierul generat e PHP valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rescue-'));
    try {
      const file = join(dir, 'dax-rescue.php');
      writeFileSync(file, renderRescuePlugin({ ...defaultRescueConfig(), disabled_plugins: ["o'ciudat"], maintenance: true, maintenance_message: 'Revenim <b>imediat</b> "azi"' }));
      expect(execFileSync('php', ['-l', file], { encoding: 'utf8' })).toContain('No syntax errors');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
