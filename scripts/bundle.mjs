/* global process, console */
// Builds the self-contained plugin runtime: plugin-dist/glassbox.mjs (all
// dependencies bundled, Node built-ins only) plus the tree-sitter wasm files
// it loads. The output is committed, so a Claude Code marketplace install
// (a plain git checkout, no npm install) can run it with `node`.
//
//   node scripts/bundle.mjs           write plugin-dist/
//   node scripts/bundle.mjs --check   fail when plugin-dist/ differs from a fresh build
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'plugin-dist');
const GRAMMARS = ['typescript', 'tsx', 'javascript', 'python'];
const require = createRequire(join(ROOT, 'package.json'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const check = process.argv.includes('--check');

async function bundleInto(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/cli/index.ts'],
    outfile: join(dir, 'glassbox.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Bundled CommonJS dependencies call require() for Node built-ins.
    banner: { js: "import { createRequire as __glassboxRequire } from 'node:module';\nconst require = __glassboxRequire(import.meta.url);" },
    define: { __GLASSBOX_BUNDLE__: JSON.stringify({ version: pkg.version }) },
    legalComments: 'eof',
    charset: 'utf8',
    logLevel: 'warning',
  });
  const grammars = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
  for (const g of GRAMMARS) copyFileSync(join(grammars, `tree-sitter-${g}.wasm`), join(dir, `tree-sitter-${g}.wasm`));
  copyFileSync(require.resolve('web-tree-sitter/tree-sitter.wasm'), join(dir, 'tree-sitter.wasm'));
}

if (!check) {
  await bundleInto(OUT_DIR);
  console.log(`wrote ${readdirSync(OUT_DIR).length} files to plugin-dist/`);
} else {
  const fresh = mkdtempSync(join(tmpdir(), 'glassbox-bundle-'));
  try {
    await bundleInto(fresh);
    const want = readdirSync(fresh).sort();
    let have = [];
    try {
      have = readdirSync(OUT_DIR).sort();
    } catch {
      // Missing directory: reported below.
    }
    const stale = want.filter((f) => !have.includes(f) || !readFileSync(join(fresh, f)).equals(readFileSync(join(OUT_DIR, f))));
    const extra = have.filter((f) => !want.includes(f));
    if (stale.length || extra.length) {
      console.error(`plugin-dist/ is out of date (${[...stale, ...extra].join(', ')}); run \`npm run bundle\` and commit the result`);
      process.exit(1);
    }
    console.log('plugin-dist/ is up to date');
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}
