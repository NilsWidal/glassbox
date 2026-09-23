import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/graph/index.js';
import { GraphStore, openStore } from '../../src/memory/store.js';
import type { GraphEdge, GraphNode } from '../../src/types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-repo');

function node(id: string, hash: string, kind: GraphNode['kind'] = 'function'): GraphNode {
  const file = id.split('#')[0]!;
  return { id, kind, file, name: id.split('#')[1] ?? file, startLine: 1, endLine: 2, hash, lang: 'typescript' };
}

describe('GraphStore basics', () => {
  let s: GraphStore;
  beforeEach(() => {
    s = new GraphStore(':memory:');
  });
  afterEach(() => s.close());

  it('upserts nodes by id and round-trips them', () => {
    s.upsertNodes([node('a.ts#f', 'h1'), node('a.ts#g', 'h2')]);
    s.upsertNodes([{ ...node('a.ts#f', 'h1'), startLine: 5, endLine: 9 }]);
    expect(s.getNodes()).toHaveLength(2);
    expect(s.getNode('a.ts#f')).toMatchObject({ startLine: 5, endLine: 9, hash: 'h1', stale: true });
    expect(s.getNodes({ file: 'a.ts', kind: 'function' }).map((n) => n.id)).toEqual(['a.ts#g', 'a.ts#f']); // ordered by line
  });

  it('changedNodes reports new and re-hashed ids only', () => {
    s.upsertNodes([node('a.ts#f', 'h1'), node('a.ts#g', 'h2')]);
    expect(s.changedNodes({ 'a.ts#f': 'h1', 'a.ts#g': 'CHANGED', 'a.ts#new': 'h3' }).sort()).toEqual(['a.ts#g', 'a.ts#new']);
    expect(s.changedNodes(new Map([['a.ts#f', 'h1']]))).toEqual([]);
  });

  it('keeps the stale flag when the hash is unchanged and sets it when it changes', () => {
    s.upsertNodes([node('a.ts#f', 'h1')]);
    s.clearStale();
    s.upsertNodes([node('a.ts#f', 'h1')]);
    expect(s.getNode('a.ts#f')!.stale).toBe(false);
    s.upsertNodes([node('a.ts#f', 'h2')]);
    expect(s.getNode('a.ts#f')!.stale).toBe(true);
  });

  it('propagates staleness exactly one hop to dependents', () => {
    // c calls b calls a; file contains all three.
    s.upsertNodes([node('x.ts', 'f', 'file'), node('x.ts#a', '1'), node('x.ts#b', '2'), node('x.ts#c', '3')]);
    const edges: GraphEdge[] = [
      { from: 'x.ts#b', to: 'x.ts#a', kind: 'calls' },
      { from: 'x.ts#c', to: 'x.ts#b', kind: 'calls' },
      { from: 'x.ts', to: 'x.ts#a', kind: 'contains' },
    ];
    s.upsertEdges(edges);
    s.upsertEdges(edges); // idempotent
    expect(s.getEdges()).toHaveLength(3);
    s.clearStale();
    expect(s.dependents(['x.ts#a']).sort()).toEqual(['x.ts', 'x.ts#b']);
    expect(s.markStale(['x.ts#a'])).toEqual(['x.ts', 'x.ts#a', 'x.ts#b']);
    expect(s.getNode('x.ts#c')!.stale).toBe(false);
    s.clearStale(['x.ts#a']);
    expect(s.staleNodes().map((n) => n.id)).toEqual(['x.ts', 'x.ts#b']);
    expect(s.markStale(['x.ts#c', 'missing'], { propagate: false })).toEqual(['x.ts#c']);
  });

  it('stores tags, detects stale tags by hash, and deletes them with the node', () => {
    s.upsertNodes([node('a.ts#f', 'h1'), node('a.ts#g', 'h2')]);
    s.setTags([
      { nodeId: 'a.ts#f', questionId: 'auth', answer: 'true', p: 0.9, confidence: 0.8, hash: 'h1' },
      { nodeId: 'a.ts#g', questionId: 'auth', answer: 'false', p: 0.7, confidence: 0.4, hash: 'h2' },
    ]);
    s.setTag({ nodeId: 'a.ts#f', questionId: 'auth', answer: 'false', p: 0.6, confidence: 0.2, hash: 'h1' });
    expect(s.getTag('a.ts#f', 'auth')).toEqual({ nodeId: 'a.ts#f', questionId: 'auth', answer: 'false', p: 0.6, confidence: 0.2, hash: 'h1' });
    expect(s.tagsForQuestion('auth')).toHaveLength(2);
    expect(s.staleTags()).toEqual([]);
    s.upsertNodes([node('a.ts#f', 'h1-edited')]);
    expect(s.staleTags().map((t) => t.nodeId)).toEqual(['a.ts#f']);
    s.deleteNodes(['a.ts#f']);
    expect(s.getTags('a.ts#f')).toEqual([]);
    s.deleteTags('a.ts#g', 'auth');
    expect(s.tagsForQuestion('auth')).toEqual([]);
  });

  it('rolls back a failed transaction', () => {
    expect(() =>
      s.transaction(() => {
        s.upsertNodes([node('a.ts#f', 'h1')]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.getNodes()).toEqual([]);
  });
});

describe('GraphStore.sync with the sample repo', () => {
  let root: string;
  let s: GraphStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'glassbox-store-'));
    await cp(FIXTURE, root, { recursive: true });
    s = openStore(root);
  });
  afterEach(async () => {
    s.close();
    await rm(root, { recursive: true, force: true });
  });

  it('creates .glassbox/graph.db and persists across opens', async () => {
    const g = await buildGraph(root);
    const first = s.sync(g);
    expect(existsSync(join(root, '.glassbox', 'graph.db'))).toBe(true);
    expect(first.added).toHaveLength(g.nodes.length);
    expect(first.changed).toEqual([]);
    s.close();
    s = GraphStore.open(root);
    expect(s.getNodes()).toHaveLength(g.nodes.length);
    expect(s.getEdges()).toHaveLength(g.edges.length);
    // The store directory is skipped by the walker.
    expect((await buildGraph(root)).files).toEqual(g.files);
  });

  it('a no-op re-index changes nothing and marks nothing stale', async () => {
    s.sync(await buildGraph(root));
    s.clearStale();
    const r = s.sync(await buildGraph(root));
    expect(r).toEqual({ added: [], changed: [], removed: [], stale: [] });
  });

  it('marks an edited function, its container and its callers stale, but not callers of callers', async () => {
    s.sync(await buildGraph(root));
    s.clearStale();
    const file = join(root, 'src/auth/session.ts');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('if (!session) return null;', 'if (!session || !token) return null;'));

    const r = s.sync(await buildGraph(root), { files: ['src/auth/session.ts'] });
    expect(r.changed).toEqual(['src/auth/session.ts', 'src/auth/session.ts#verifySession']);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.stale).toContain('src/auth/middleware.ts#requireAuth');
    expect(r.stale).toContain('src/auth/middleware.ts'); // imports session.ts
    expect(r.stale).toContain('src/api/routes.ts'); // imports session.ts
    expect(r.stale).not.toContain('src/auth/middleware.ts#requireAdmin'); // two hops away
    expect(r.stale).not.toContain('src/auth/session.ts#issueToken'); // unchanged sibling
    expect(s.staleNodes().map((n) => n.id).sort()).toEqual(r.stale);
  });

  it('removes deleted functions with their edges and marks their callers stale', async () => {
    s.sync(await buildGraph(root));
    s.clearStale();
    const file = join(root, 'src/ui/format.ts');
    await writeFile(file, `export function formatCurrency(amount: number, currency = 'USD'): string {\n  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);\n}\n\nexport function formatPercent(x: number): string {\n  return (x * 100).toFixed(1) + '%';\n}\n`);

    const r = s.sync(await buildGraph(root));
    expect(r.removed).toEqual(['src/ui/format.ts#formatDate']);
    expect(r.added).toEqual(['src/ui/format.ts#formatPercent']);
    expect(r.changed).toEqual(['src/ui/format.ts']);
    expect(r.stale).toContain('src/ui/InvoiceTable.tsx#InvoiceTable');
    expect(s.getNode('src/ui/format.ts#formatDate')).toBeUndefined();
    expect(s.edgesTo('src/ui/format.ts#formatDate')).toEqual([]);
    expect(s.edgesFrom('src/ui/InvoiceTable.tsx#InvoiceTable', 'calls').map((e) => e.to)).toEqual(['src/ui/format.ts#formatCurrency']);
  });
});
