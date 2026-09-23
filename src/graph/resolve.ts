import { posix } from 'node:path';
import type { GraphEdge } from '../types.js';
import type { FileExtract } from './extract.js';

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Member names so generic that matching them by name alone would invent
 * edges (Map.get, list.append, ...). They still resolve through this./self.,
 * imports and known instances.
 */
const GENERIC_MEMBERS = new Set([
  'get', 'set', 'has', 'delete', 'add', 'clear', 'push', 'pop', 'shift', 'map', 'filter', 'reduce',
  'forEach', 'find', 'some', 'every', 'then', 'catch', 'finally', 'join', 'split', 'replace', 'slice',
  'append', 'extend', 'keys', 'values', 'items', 'update', 'format', 'toString', 'log', 'run', 'close',
  'open', 'read', 'write', 'send', 'emit', 'on', 'call', 'apply', 'bind', 'next', 'save', 'load', 'init',
]);

function resolveTs(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/^\/+/, '');
  const cands = [base];
  const ext = posix.extname(base);
  for (const alt of JS_TO_TS[ext] ?? []) cands.push(base.slice(0, -ext.length) + alt);
  for (const e of TS_EXTS) cands.push(base + e);
  for (const e of TS_EXTS) cands.push(`${base}/index${e}`);
  return cands.find((c) => files.has(c)) ?? null;
}

function pyCandidates(modPath: string): string[] {
  return modPath ? [`${modPath}.py`, `${modPath}/__init__.py`] : [];
}

/** Resolves a Python module spec ('.utils', '..pkg.mod', 'worker.utils') to a file. */
function resolvePy(from: string, spec: string, files: Set<string>, pyFiles: string[]): string | null {
  const m = /^(\.*)(.*)$/.exec(spec);
  const dots = m?.[1]?.length ?? 0;
  const rest = (m?.[2] ?? '').replace(/\./g, '/');
  if (dots > 0) {
    let dir = posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    if (dir === '.') dir = '';
    const joined = rest ? (dir ? `${dir}/${rest}` : rest) : dir;
    const cands = rest ? pyCandidates(joined) : [dir ? `${dir}/__init__.py` : '__init__.py'];
    return cands.find((c) => files.has(c)) ?? null;
  }
  // Absolute: the repo root or any source root (src/, lib/...) may be on sys.path.
  const cands = pyCandidates(rest);
  for (const c of cands) if (files.has(c)) return c;
  const hits = pyFiles.filter((f) => cands.some((c) => f.endsWith(`/${c}`)));
  hits.sort((a, b) => a.length - b.length);
  return hits[0] ?? null;
}

type Binding = { file: string; imported: string } | { file: string; namespace: true };

export interface ResolvedEdges {
  imports: GraphEdge[];
  calls: GraphEdge[];
}

/** Resolves imports to files and calls to nodes across the whole repo, best effort. */
export function resolveEdges(extracts: FileExtract[]): ResolvedEdges {
  const files = new Set(extracts.map((x) => x.file));
  const pyFiles = extracts.filter((x) => x.lang === 'python').map((x) => x.file);
  const byFile = new Map(extracts.map((x) => [x.file, x]));

  // Top-level definitions per file, and repo-wide name indexes for fallback.
  const topLevel = new Map<string, Map<string, string>>();
  const byName = new Map<string, string[]>();
  const methodsByName = new Map<string, string[]>();
  for (const x of extracts) {
    const top = new Map<string, string>();
    for (const n of x.nodes) {
      if (n.kind === 'file') continue;
      if (n.kind === 'method') {
        const short = n.name.slice(n.name.lastIndexOf('.') + 1);
        methodsByName.set(short, [...(methodsByName.get(short) ?? []), n.id]);
      } else if (!n.name.includes('.')) {
        top.set(n.name, n.id);
        byName.set(n.name, [...(byName.get(n.name) ?? []), n.id]);
      }
    }
    if (x.defaultExport && top.has(x.defaultExport)) top.set('default', top.get(x.defaultExport)!);
    topLevel.set(x.file, top);
  }
  const nodeIds = new Set(extracts.flatMap((x) => x.nodes.map((n) => n.id)));

  const importEdges: GraphEdge[] = [];
  const callEdges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (list: GraphEdge[], e: GraphEdge) => {
    const k = `${e.from}\0${e.to}\0${e.kind}`;
    if (!seen.has(k)) {
      seen.add(k);
      list.push(e);
    }
  };

  for (const x of extracts) {
    const isPy = x.lang === 'python';
    const resolve = (spec: string) => (isPy ? resolvePy(x.file, spec, files, pyFiles) : resolveTs(x.file, spec, files));
    const bindings = new Map<string, Binding>();

    for (const imp of x.imports) {
      const target = resolve(imp.spec);
      if (target) push(importEdges, { from: x.file, to: target, kind: 'imports' });
      if (target && imp.namespace) bindings.set(imp.namespace, { file: target, namespace: true });
      for (const b of imp.names) {
        // `from pkg import mod` may name a submodule rather than a symbol.
        const sub = isPy ? resolve(imp.spec.endsWith('.') ? imp.spec + b.imported : `${imp.spec}.${b.imported}`) : null;
        if (target && topLevel.get(target)?.has(b.imported)) {
          bindings.set(b.local, { file: target, imported: b.imported });
        } else if (sub) {
          push(importEdges, { from: x.file, to: sub, kind: 'imports' });
          bindings.set(b.local, { file: sub, namespace: true });
        } else if (target) {
          bindings.set(b.local, { file: target, imported: b.imported });
        }
      }
    }

    const top = topLevel.get(x.file)!;
    const unique = (name: string): string | undefined => {
      const ids = byName.get(name);
      return ids?.length === 1 ? ids[0] : undefined;
    };
    // A bare name: imported symbol, then same-file definition, then unique in repo.
    const lookupName = (name: string): string | undefined => {
      const b = bindings.get(name);
      if (b && !('namespace' in b)) {
        const hit = topLevel.get(b.file)?.get(b.imported);
        if (hit) return hit;
      }
      return top.get(name) ?? (b ? undefined : unique(name));
    };
    const methodOf = (classId: string | undefined, name: string): string | undefined => {
      if (!classId) return undefined;
      const id = `${classId}.${name}`;
      return nodeIds.has(id) ? id : undefined;
    };

    for (const c of x.calls) {
      let to: string | undefined;
      if (c.object === undefined) {
        to = lookupName(c.name);
      } else if (c.object === 'this' || c.object === 'self' || c.object === 'cls') {
        const cls = x.classOf[c.from];
        to = cls ? methodOf(`${x.file}#${cls}`, c.name) : undefined;
      } else {
        const b = bindings.get(c.object);
        if (b && 'namespace' in b) {
          to = topLevel.get(b.file)?.get(c.name);
        } else {
          const className = x.instances[c.object] ?? c.object;
          to = methodOf(lookupName(className), c.name);
          if (!to && !c.object.startsWith('this.') && !GENERIC_MEMBERS.has(c.name)) {
            const ids = methodsByName.get(c.name);
            if (ids?.length === 1) to = ids[0];
          }
        }
      }
      if (to && byFile.has(to.split('#')[0] ?? '')) push(callEdges, { from: c.from, to, kind: 'calls' });
    }
  }

  return { imports: importEdges, calls: callEdges };
}
