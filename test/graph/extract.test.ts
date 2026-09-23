import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleGraph, contentHash, extractSource, grammarFor, grammarWasmPath, normalizeSource } from '../../src/graph/index.js';

const ids = (x: { nodes: { id: string }[] }) => x.nodes.map((n) => n.id);

describe('languages', () => {
  it('maps extensions to grammars and skips declaration files', () => {
    expect(grammarFor('a/b.ts')).toBe('typescript');
    expect(grammarFor('a/b.tsx')).toBe('tsx');
    expect(grammarFor('a/b.mjs')).toBe('javascript');
    expect(grammarFor('a/b.py')).toBe('python');
    expect(grammarFor('a/b.d.ts')).toBeNull();
    expect(grammarFor('README.md')).toBeNull();
  });

  it('resolves grammar wasm files from the installed package', () => {
    for (const g of ['typescript', 'tsx', 'javascript', 'python'] as const) {
      expect(existsSync(grammarWasmPath(g))).toBe(true);
    }
  });
});

describe('hashing', () => {
  it('ignores line endings, trailing spaces, blank lines and indentation level', () => {
    const a = 'function f() {\n  return 1;\n}\n';
    const b = '    function f() {  \r\n\r\n      return 1;\r\n    }';
    expect(normalizeSource(b)).toBe(normalizeSource(a));
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).not.toBe(contentHash(a.replace('1', '2')));
  });
});

describe('extractSource: TypeScript', () => {
  const src = `import def, { a as b, c } from './lib.js';
import * as ns from '../ns';
export { q } from './q';

export function top(x: number) {
  const inner = () => b(x);
  return inner() + c() + ns.go();
}

export const arrow = async (s: string) => top(s.length);

const notAFunction = 5;

export class Svc extends Base {
  private cache = new Map<string, number>();
  handler = () => this.run();
  run(): void {
    this.cache.get('x');
    helper();
  }
  static make() { return new Svc(); }
}

function helper() {}
export default Svc;
`;

  it('extracts files, functions, arrow consts, classes and methods with line ranges', async () => {
    const x = await extractSource('src/mod.ts', src);
    expect(ids(x)).toEqual([
      'src/mod.ts',
      'src/mod.ts#top',
      'src/mod.ts#arrow',
      'src/mod.ts#Svc',
      'src/mod.ts#Svc.handler',
      'src/mod.ts#Svc.run',
      'src/mod.ts#Svc.make',
      'src/mod.ts#helper',
    ]);
    const top = x.nodes.find((n) => n.id === 'src/mod.ts#top')!;
    expect([top.kind, top.startLine, top.endLine, top.lang]).toEqual(['function', 5, 8, 'typescript']);
    expect(x.nodes.find((n) => n.name === 'Svc.run')!.kind).toBe('method');
    expect(x.nodes[0]).toMatchObject({ kind: 'file', startLine: 1, endLine: 25 });
    expect(x.defaultExport).toBe('Svc');
  });

  it('adds contains edges file -> top level and class -> method', async () => {
    const x = await extractSource('src/mod.ts', src);
    expect(x.edges).toContainEqual({ from: 'src/mod.ts', to: 'src/mod.ts#Svc', kind: 'contains' });
    expect(x.edges).toContainEqual({ from: 'src/mod.ts#Svc', to: 'src/mod.ts#Svc.run', kind: 'contains' });
    expect(x.edges.every((e) => e.kind === 'contains')).toBe(true);
  });

  it('records imports with bindings and calls with receivers', async () => {
    const x = await extractSource('src/mod.ts', src);
    expect(x.imports).toEqual([
      { spec: './lib.js', names: [{ local: 'def', imported: 'default' }, { local: 'b', imported: 'a' }, { local: 'c', imported: 'c' }] },
      { spec: '../ns', names: [], namespace: 'ns' },
      { spec: './q', names: [] },
    ]);
    // The nested arrow `inner` is folded into `top`.
    expect(x.calls).toContainEqual({ from: 'src/mod.ts#top', name: 'b' });
    expect(x.calls).toContainEqual({ from: 'src/mod.ts#top', name: 'go', object: 'ns' });
    expect(x.calls).toContainEqual({ from: 'src/mod.ts#Svc.handler', name: 'run', object: 'this' });
    expect(x.calls).toContainEqual({ from: 'src/mod.ts#Svc.make', name: 'Svc' });
  });

  it('treats capitalized JSX tags as calls and ignores DOM tags', async () => {
    const x = await extractSource('src/App.tsx', `export const App = () => <div><Header title="x" /><ui.Footer></ui.Footer></div>;`);
    expect(x.calls).toContainEqual({ from: 'src/App.tsx#App', name: 'Header' });
    expect(x.calls).toContainEqual({ from: 'src/App.tsx#App', name: 'Footer', object: 'ui' });
    expect(x.calls.some((c) => c.name === 'div')).toBe(false);
  });

  it('parses plain JavaScript with require', async () => {
    const x = await extractSource('lib/a.js', `const util = require('./util');\nfunction go() { return util.run(); }\nmodule.exports = { go };\n`);
    expect(ids(x)).toEqual(['lib/a.js', 'lib/a.js#go']);
    expect(x.imports).toEqual([{ spec: './util', names: [], namespace: 'util' }]);
    expect(x.lang).toBe('javascript');
  });

  it('disambiguates duplicate names with the start line', async () => {
    const x = await extractSource('a.ts', `function f() {}\nfunction f() {}\n`);
    expect(ids(x)).toEqual(['a.ts', 'a.ts#f', 'a.ts#f@2']);
  });

  it('gives unchanged functions the same hash when other code moves', async () => {
    const a = await extractSource('a.ts', `function f() { return 1; }\n`);
    const b = await extractSource('a.ts', `// header\n\nfunction g() {}\nfunction f() { return 1; }\n`);
    const fa = a.nodes.find((n) => n.name === 'f')!;
    const fb = b.nodes.find((n) => n.name === 'f')!;
    expect(fb.hash).toBe(fa.hash);
    expect(fb.startLine).toBe(4);
    expect(b.nodes[0]!.hash).not.toBe(a.nodes[0]!.hash);
  });
});

describe('extractSource: Python', () => {
  const src = `import os.path, json as j
from . import sibling
from ..pkg.mod import thing as t, other

@decorator
def top(x):
    def nested():
        return helper(x)
    return nested() + t(x) + j.dumps(x)

class Model(Base):
    def __init__(self):
        self.save()

    @staticmethod
    def build():
        m = Model()
        m.save()
        return m

    def save(self):
        os.path.join("a", "b")
`;

  it('extracts functions, decorated functions, classes and methods', async () => {
    const x = await extractSource('app/core.py', src);
    expect(ids(x)).toEqual([
      'app/core.py',
      'app/core.py#top',
      'app/core.py#Model',
      'app/core.py#Model.__init__',
      'app/core.py#Model.build',
      'app/core.py#Model.save',
    ]);
    const top = x.nodes.find((n) => n.name === 'top')!;
    expect([top.startLine, top.endLine, top.lang]).toEqual([5, 9, 'python']);
    const build = x.nodes.find((n) => n.name === 'Model.build')!;
    expect([build.kind, build.startLine]).toEqual(['method', 15]);
  });

  it('records imports, instances and calls', async () => {
    const x = await extractSource('app/core.py', src);
    expect(x.imports).toEqual([
      { spec: 'os.path', names: [], namespace: 'os.path' },
      { spec: 'json', names: [], namespace: 'j' },
      { spec: '.', names: [{ local: 'sibling', imported: 'sibling' }] },
      { spec: '..pkg.mod', names: [{ local: 't', imported: 'thing' }, { local: 'other', imported: 'other' }] },
    ]);
    expect(x.instances).toEqual({ m: 'Model' });
    expect(x.calls).toContainEqual({ from: 'app/core.py', name: 'decorator' });
    expect(x.calls).toContainEqual({ from: 'app/core.py#top', name: 'helper' });
    expect(x.calls).toContainEqual({ from: 'app/core.py#Model.__init__', name: 'save', object: 'self' });
    expect(x.calls).toContainEqual({ from: 'app/core.py#Model.save', name: 'join', object: 'os.path' });
  });
});

describe('resolveEdges', () => {
  it('links TS imports (.js specifiers, extensionless, index files) and calls across files', async () => {
    const g = assembleGraph([
      await extractSource('src/a.ts', `import { b } from './b.js';\nimport { C } from './c';\nimport * as u from './util';\nexport function a() { b(); new C().m(); u.help(); }\n`),
      await extractSource('src/b.ts', `export function b() { return 1; }\n`),
      await extractSource('src/c/index.ts', `export class C { m() { this.n(); } n() {} }\n`),
      await extractSource('src/util.ts', `export const help = () => 1;\n`),
    ]);
    const other = g.edges.filter((e) => e.kind !== 'contains');
    expect(other).toEqual(
      expect.arrayContaining([
        { from: 'src/a.ts', to: 'src/b.ts', kind: 'imports' },
        { from: 'src/a.ts', to: 'src/c/index.ts', kind: 'imports' },
        { from: 'src/a.ts', to: 'src/util.ts', kind: 'imports' },
        { from: 'src/a.ts#a', to: 'src/b.ts#b', kind: 'calls' },
        { from: 'src/a.ts#a', to: 'src/c/index.ts#C', kind: 'calls' },
        { from: 'src/a.ts#a', to: 'src/util.ts#help', kind: 'calls' },
        { from: 'src/c/index.ts#C.m', to: 'src/c/index.ts#C.n', kind: 'calls' },
      ]),
    );
  });

  it('does not invent edges for unresolved or generic names', async () => {
    const g = assembleGraph([
      await extractSource('a.ts', `import x from 'react';\nexport function a(m: Map<string, number>) { m.get('k'); x(); }\n`),
      await extractSource('b.ts', `export class Cache { get() {} }\n`),
    ]);
    expect(g.edges.filter((e) => e.kind !== 'contains')).toEqual([]);
  });

  it('resolves Python relative, absolute and submodule imports', async () => {
    const g = assembleGraph([
      await extractSource('pkg/__init__.py', ''),
      await extractSource('pkg/a.py', `from . import b\nfrom .c import go\nimport pkg.c as cc\n\ndef run():\n    b.helper()\n    go()\n    cc.go()\n`),
      await extractSource('pkg/b.py', `def helper():\n    pass\n`),
      await extractSource('pkg/c.py', `def go():\n    pass\n`),
    ]);
    const other = g.edges.filter((e) => e.kind !== 'contains');
    expect(other).toEqual(
      expect.arrayContaining([
        { from: 'pkg/a.py', to: 'pkg/__init__.py', kind: 'imports' },
        { from: 'pkg/a.py', to: 'pkg/b.py', kind: 'imports' },
        { from: 'pkg/a.py', to: 'pkg/c.py', kind: 'imports' },
        { from: 'pkg/a.py#run', to: 'pkg/b.py#helper', kind: 'calls' },
        { from: 'pkg/a.py#run', to: 'pkg/c.py#go', kind: 'calls' },
      ]),
    );
  });
});
