// Verifică sintaxa fișierelor PHP (plugin WordPress + hook WHMCS) cu `php -l`.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['integrations'];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.php')) files.push(p);
  }
};
roots.forEach(walk);
let failed = 0;
for (const f of files) {
  try {
    execFileSync('php', ['-l', f], { stdio: 'pipe' });
    console.log(`OK   ${f}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${f}\n${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`);
  }
}
if (failed) process.exit(1);
