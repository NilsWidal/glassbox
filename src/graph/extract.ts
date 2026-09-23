import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { GraphEdge, GraphNode, NodeKind } from '../types.js';
import { contentHash } from './hash.js';
import { type Grammar, getParser, grammarFor, langOf } from './languages.js';

/** One name brought in by an import. `imported` is 'default' for default imports. */
export interface ImportBinding {
  local: string;
  imported: string;
}

export interface RawImport {
  /** Module specifier as written: './x.js', 'react', '.utils', 'worker.utils'. */
  spec: string;
  names: ImportBinding[];
  /** Local name bound to the whole module (`import * as ns`, `import a.b as c`). */
  namespace?: string;
}

export interface RawCall {
  /** Id of the innermost extracted node containing the call (file id at top level). */
  from: string;
  name: string;
  /** Receiver text for member calls: 'this', 'self', 'store', 'u', 'a.b'. */
  object?: string;
}

export interface FileExtract {
  file: string;
  lang: string;
  nodes: GraphNode[];
  /** Only `contains` edges; imports and calls need the whole repo to resolve. */
  edges: GraphEdge[];
  imports: RawImport[];
  calls: RawCall[];
  /** Local variable -> class name, from `x = new Foo()` / `x = Foo()`. */
  instances: Record<string, string>;
  /** Top-level name exported as default, if known. */
  defaultExport?: string;
  /** Node id -> qualified class name, for resolving this./self. calls. */
  classOf: Record<string, string>;
}

const TS_FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const TS_CLASS = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const TS_FUNCTION_DECL = new Set(['function_declaration', 'generator_function_declaration']);

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

function children(n: SyntaxNode): SyntaxNode[] {
  return n.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

interface Ctx {
  /** Node id that owns calls found here. */
  owner: string;
  /** Qualified class name when directly inside a class body. */
  cls?: string;
  /** Inside a function body: nested definitions are folded into the owner. */
  inFunction: boolean;
}

class Extractor {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  readonly imports: RawImport[] = [];
  readonly calls: RawCall[] = [];
  readonly instances: Record<string, string> = {};
  readonly classOf: Record<string, string> = {};
  defaultExport?: string;
  private readonly ids = new Set<string>();

  constructor(
    readonly file: string,
    readonly lang: string,
  ) {}

  add(kind: NodeKind, name: string, range: SyntaxNode, parent: string, cls?: string): string {
    let id = `${this.file}#${name}`;
    if (this.ids.has(id)) id = `${id}@${range.startPosition.row + 1}`;
    this.ids.add(id);
    this.nodes.push({
      id,
      kind,
      file: this.file,
      name,
      startLine: range.startPosition.row + 1,
      endLine: range.endPosition.row + 1,
      hash: contentHash(range.text),
      lang: this.lang,
    });
    this.edges.push({ from: parent, to: id, kind: 'contains' });
    if (cls) this.classOf[id] = cls;
    return id;
  }

  call(ctx: Ctx, name: string, object?: string): void {
    if (!name) return;
    this.calls.push(object === undefined ? { from: ctx.owner, name } : { from: ctx.owner, name, object });
  }

  // ---------------------------------------------------------------- TS / JS

  ts(n: SyntaxNode, ctx: Ctx): void {
    const t = n.type;

    if (t === 'import_statement') return this.tsImport(n);
    if (t === 'export_statement') {
      const src = n.childForFieldName('source');
      if (src) this.imports.push({ spec: stripQuotes(src.text), names: [] });
      const value = n.childForFieldName('value');
      if (value?.type === 'identifier') this.defaultExport = value.text;
      if (value && TS_FUNCTION_VALUES.has(value.type) && !ctx.inFunction) {
        this.defaultExport = 'default';
        const id = this.add('function', 'default', n, ctx.owner);
        return this.tsChildren(value, { owner: id, inFunction: true });
      }
      const decl = n.childForFieldName('declaration');
      if (decl && n.text.startsWith('export default')) {
        const name = decl.childForFieldName('name');
        if (name) this.defaultExport = name.text;
      }
      return this.tsChildren(n, ctx);
    }

    if (!ctx.inFunction && TS_FUNCTION_DECL.has(t)) {
      const name = n.childForFieldName('name')?.text ?? 'default';
      const id = this.add('function', name, n, ctx.owner);
      return this.tsChildren(n, { owner: id, inFunction: true });
    }

    if (!ctx.inFunction && TS_CLASS.has(t)) {
      const nameNode = n.childForFieldName('name');
      if (nameNode) {
        const qname = ctx.cls ? `${ctx.cls}.${nameNode.text}` : nameNode.text;
        const id = this.add('class', qname, n, ctx.owner);
        const body = n.childForFieldName('body');
        // Heritage clauses (extends X) count as references from the class.
        for (const c of children(n)) if (c.type !== 'class_body') this.ts(c, { owner: id, inFunction: false });
        if (body) this.tsClassBody(body, id, qname);
        return;
      }
    }

    if (!ctx.inFunction && t === 'variable_declarator') {
      const name = n.childForFieldName('name');
      const value = n.childForFieldName('value');
      if (name?.type === 'identifier' && value && TS_FUNCTION_VALUES.has(value.type)) {
        const id = this.add('function', name.text, n, ctx.owner);
        return this.tsChildren(value, { owner: id, inFunction: true });
      }
    }

    if (t === 'variable_declarator') {
      const name = n.childForFieldName('name');
      const value = n.childForFieldName('value');
      if (name?.type === 'identifier' && value?.type === 'new_expression') {
        const ctor = value.childForFieldName('constructor');
        if (ctor?.type === 'identifier') this.instances[name.text] = ctor.text;
      }
      // const x = require('./y')
      if (name?.type === 'identifier' && value?.type === 'call_expression') {
        const spec = this.requireSpec(value);
        if (spec !== null) {
          this.imports.push({ spec, names: [], namespace: name.text });
          return;
        }
      }
    }

    if (t === 'call_expression') {
      const spec = this.requireSpec(n);
      if (spec !== null) {
        this.imports.push({ spec, names: [] });
      } else {
        this.tsCallee(n.childForFieldName('function'), ctx);
      }
    } else if (t === 'new_expression') {
      this.tsCallee(n.childForFieldName('constructor'), ctx);
    } else if (t === 'jsx_opening_element' || t === 'jsx_self_closing_element') {
      const name = n.childForFieldName('name');
      // Lowercase tags are DOM elements, not components.
      if (name && /^[A-Z]/.test(name.text.split('.').pop() ?? '')) this.tsCallee(name, ctx);
    }

    this.tsChildren(n, ctx);
  }

  tsChildren(n: SyntaxNode, ctx: Ctx): void {
    for (const c of children(n)) this.ts(c, ctx);
  }

  tsClassBody(body: SyntaxNode, classId: string, qname: string): void {
    for (const m of children(body)) {
      const name = m.childForFieldName('name') ?? m.childForFieldName('property');
      if (m.type === 'method_definition' && name) {
        const id = this.add('method', `${qname}.${name.text}`, m, classId, qname);
        this.tsChildren(m, { owner: id, inFunction: true });
      } else if (
        (m.type === 'public_field_definition' || m.type === 'field_definition') &&
        name &&
        TS_FUNCTION_VALUES.has(m.childForFieldName('value')?.type ?? '')
      ) {
        const id = this.add('method', `${qname}.${name.text}`, m, classId, qname);
        this.tsChildren(m, { owner: id, inFunction: true });
      } else {
        this.ts(m, { owner: classId, cls: qname, inFunction: false });
      }
    }
  }

  tsCallee(fn: SyntaxNode | null, ctx: Ctx): void {
    if (!fn) return;
    if (fn.type === 'identifier') return this.call(ctx, fn.text);
    if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      const obj = fn.childForFieldName('object');
      if (prop && obj) this.call(ctx, prop.text, obj.text);
    }
  }

  requireSpec(call: SyntaxNode): string | null {
    const fn = call.childForFieldName('function');
    if (!fn || (fn.type !== 'import' && !(fn.type === 'identifier' && fn.text === 'require'))) return null;
    const arg = children(call.childForFieldName('arguments') ?? call)[0];
    return arg?.type === 'string' ? stripQuotes(arg.text) : null;
  }

  tsImport(n: SyntaxNode): void {
    const src = n.childForFieldName('source');
    if (!src) return;
    const imp: RawImport = { spec: stripQuotes(src.text), names: [] };
    const clause = children(n).find((c) => c.type === 'import_clause');
    for (const c of clause ? children(clause) : []) {
      if (c.type === 'identifier') imp.names.push({ local: c.text, imported: 'default' });
      else if (c.type === 'namespace_import') imp.namespace = children(c)[0]?.text;
      else if (c.type === 'named_imports') {
        for (const s of children(c)) {
          if (s.type !== 'import_specifier') continue;
          const name = s.childForFieldName('name')?.text;
          const alias = s.childForFieldName('alias')?.text;
          if (name) imp.names.push({ local: alias ?? name, imported: name });
        }
      }
    }
    this.imports.push(imp);
  }

  // ---------------------------------------------------------------- Python

  py(n: SyntaxNode, ctx: Ctx): void {
    const t = n.type;
    if (t === 'import_statement') return this.pyImport(n);
    if (t === 'import_from_statement') return this.pyFromImport(n);

    if (!ctx.inFunction && (t === 'function_definition' || t === 'class_definition' || t === 'decorated_definition')) {
      const def = t === 'decorated_definition' ? n.childForFieldName('definition') : n;
      const name = def?.childForFieldName('name');
      if (def && name) {
        // Decorators run at definition time, in the enclosing scope.
        if (t === 'decorated_definition') {
          for (const d of children(n)) if (d.type === 'decorator') this.py(d, ctx);
        }
        const qname = ctx.cls ? `${ctx.cls}.${name.text}` : name.text;
        if (def.type === 'class_definition') {
          const id = this.add('class', qname, n, ctx.owner);
          const body = def.childForFieldName('body');
          const sup = def.childForFieldName('superclasses');
          if (sup) this.py(sup, ctx);
          if (body) for (const c of children(body)) this.py(c, { owner: id, cls: qname, inFunction: false });
        } else {
          const kind: NodeKind = ctx.cls ? 'method' : 'function';
          const id = this.add(kind, qname, n, ctx.owner, ctx.cls);
          const body = def.childForFieldName('body');
          if (body) this.pyChildren(body, { owner: id, inFunction: true });
        }
        return;
      }
    }

    if (t === 'assignment') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      const fn = right?.type === 'call' ? right.childForFieldName('function') : null;
      if (left?.type === 'identifier' && fn?.type === 'identifier' && /^[A-Z]/.test(fn.text)) {
        this.instances[left.text] = fn.text;
      }
    }

    if (t === 'call' || t === 'decorator') {
      // A bare `@name` decorator is a call of `name`; `@name(...)` holds a call node.
      const fn = t === 'call' ? n.childForFieldName('function') : children(n)[0] ?? null;
      if (fn?.type === 'identifier') this.call(ctx, fn.text);
      else if (fn?.type === 'attribute') {
        const attr = fn.childForFieldName('attribute');
        const obj = fn.childForFieldName('object');
        if (attr && obj) this.call(ctx, attr.text, obj.text);
      }
    }

    this.pyChildren(n, ctx);
  }

  pyChildren(n: SyntaxNode, ctx: Ctx): void {
    for (const c of children(n)) this.py(c, ctx);
  }

  pyImport(n: SyntaxNode): void {
    for (const c of n.childrenForFieldName('name')) {
      if (!c) continue;
      if (c.type === 'aliased_import') {
        const mod = c.childForFieldName('name')?.text;
        const alias = c.childForFieldName('alias')?.text;
        if (mod) this.imports.push({ spec: mod, names: [], namespace: alias ?? mod });
      } else {
        this.imports.push({ spec: c.text, names: [], namespace: c.text });
      }
    }
  }

  pyFromImport(n: SyntaxNode): void {
    const mod = n.childForFieldName('module_name');
    if (!mod) return;
    const imp: RawImport = { spec: mod.text, names: [] };
    for (const c of n.childrenForFieldName('name')) {
      if (!c) continue;
      if (c.type === 'aliased_import') {
        const name = c.childForFieldName('name')?.text;
        const alias = c.childForFieldName('alias')?.text;
        if (name) imp.names.push({ local: alias ?? name, imported: name });
      } else {
        imp.names.push({ local: c.text, imported: c.text });
      }
    }
    this.imports.push(imp);
  }
}

function countLines(source: string): number {
  if (source.length === 0) return 1;
  const n = source.split(/\r\n|\r|\n/).length;
  return /(\r\n|\r|\n)$/.test(source) ? n - 1 : n;
}

/** Parses one file's source into nodes and unresolved imports and calls. */
export async function extractSource(file: string, source: string, grammar?: Grammar): Promise<FileExtract> {
  const g = grammar ?? grammarFor(file);
  if (!g) throw new Error(`unsupported file type: ${file}`);
  const lang = langOf(g);
  const parser = await getParser(g);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`parse failed: ${file}`);
  const x = new Extractor(file, lang);
  try {
    x.nodes.push({
      id: file,
      kind: 'file',
      file,
      name: file.split('/').pop() ?? file,
      startLine: 1,
      endLine: countLines(source),
      hash: contentHash(source),
      lang,
    });
    const ctx: Ctx = { owner: file, inFunction: false };
    if (g === 'python') x.pyChildren(tree.rootNode, ctx);
    else x.tsChildren(tree.rootNode, ctx);
  } finally {
    tree.delete();
  }
  const out: FileExtract = {
    file,
    lang,
    nodes: x.nodes,
    edges: x.edges,
    imports: x.imports,
    calls: x.calls,
    instances: x.instances,
    classOf: x.classOf,
  };
  if (x.defaultExport !== undefined) out.defaultExport = x.defaultExport;
  return out;
}
