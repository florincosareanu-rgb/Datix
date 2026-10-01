// Construiește serverul într-un singur fișier ESM (dist/index.js).
// Dependențele din package.json rămân externe (inclusiv modulul nativ better-sqlite3).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const rootPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  external: Object.keys(pkg.dependencies ?? {}),
  define: {
    'process.env.DATIX_VERSION': JSON.stringify(rootPkg.version),
  },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
