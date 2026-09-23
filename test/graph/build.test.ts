import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph, type Graph, walkRepo } from '../../src/graph/index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-repo');

describe('walkRepo', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'glassbox-walk-'));
    const files: Record<string, string> = {
      '.gitignore': 'secret/\n*.gen.ts\n',
      'src/a.ts': '',
      'src/a.gen.ts': '',
      'src/types.d.ts': '',
      'src/notes.md': '',
      'secret/b.ts': '',
      'node_modules/x/index.js': '',
      'dist/out.js': '',
      '.glassbox/c.ts': '',
      'py/.gitignore': 'local_*.py\n',
      'py/app.py': '',
      'py/local_settings.py': '',
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('honors root and nested .gitignore and always skips node_modules, dist, .glassbox', async () => {
    expect(await walkRepo(root)).toEqual(['py/app.py', 'src/a.ts']);
  });

  it('accepts extra ignore patterns', async () => {
    expect(await walkRepo(root, { ignore: ['py/'] })).toEqual(['src/a.ts']);
  });
});

describe('buildGraph on the sample repo', () => {
  let g: Graph;
  const has = (from: string, to: string, kind: string) => g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

  beforeAll(async () => {
    g = await buildGraph(FIXTURE);
  });

  it('indexes TS, TSX and Python files and skips gitignored ones', () => {
    expect(g.files).toContain('src/ui/LoginForm.tsx');
    expect(g.files).toContain('worker/billing_sync.py');
    expect(g.files).not.toContain('src/build.generated.ts');
    expect(g.files).toHaveLength(17);
    expect(g.skipped).toEqual([]);
  });

  it('extracts the expected definitions', () => {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get('src/auth/middleware.ts#requireAuth')).toMatchObject({ kind: 'function', startLine: 11, endLine: 22 });
    expect(byId.get('src/auth/session.ts#SessionStore')?.kind).toBe('class');
    expect(byId.get('src/billing/invoice.ts#InvoiceService.applyDiscount')?.kind).toBe('method');
    expect(byId.get('worker/auth_audit.py#AuditLog.load')?.kind).toBe('method');
    expect(byId.get('src/ui/LoginForm.tsx#LoginForm')?.lang).toBe('typescript');
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
  });

  it('links imports between files', () => {
    expect(has('src/auth/middleware.ts', 'src/auth/session.ts', 'imports')).toBe(true);
    expect(has('src/ui/InvoiceTable.tsx', 'src/ui/format.ts', 'imports')).toBe(true);
    expect(has('worker/main.py', 'worker/utils.py', 'imports')).toBe(true);
    expect(has('worker/main.py', 'worker/billing_sync.py', 'imports')).toBe(true);
  });

  it('links calls through imports, instances and self/this', () => {
    expect(has('src/auth/middleware.ts#requireAuth', 'src/auth/session.ts#verifySession', 'calls')).toBe(true);
    expect(has('src/auth/session.ts#verifySession', 'src/auth/session.ts#SessionStore.get', 'calls')).toBe(true);
    expect(has('src/api/routes.ts#handleCreateInvoice', 'src/billing/invoice.ts#InvoiceService.createInvoice', 'calls')).toBe(true);
    expect(has('src/billing/invoice.ts#InvoiceService.pay', 'src/billing/retry.ts#retryCharge', 'calls')).toBe(true);
    expect(has('src/billing/retry.ts#retryCharge', 'src/billing/stripeClient.ts#chargeCard', 'calls')).toBe(true);
    expect(has('worker/main.py#run', 'worker/auth_audit.py#AuditLog.record', 'calls')).toBe(true);
    expect(has('worker/main.py#run', 'worker/utils.py#parse_amount', 'calls')).toBe(true);
    expect(has('worker/auth_audit.py#AuditLog.record', 'worker/auth_audit.py#AuditLog.flush', 'calls')).toBe(true);
  });

  it('only creates edges between known nodes', () => {
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it('is deterministic', async () => {
    expect(await buildGraph(FIXTURE)).toEqual(g);
  });
});
