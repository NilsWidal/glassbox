import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

/** Grammar used to parse a file. `lang` on nodes is coarser (tsx is typescript). */
export type Grammar = 'typescript' | 'tsx' | 'javascript' | 'python';
export type Lang = 'typescript' | 'javascript' | 'python';

const EXT_GRAMMAR: Record<string, Grammar> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT_GRAMMAR);

export function grammarFor(file: string): Grammar | null {
  if (/\.d\.[mc]?ts$/.test(file)) return null;
  const dot = file.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_GRAMMAR[file.slice(dot).toLowerCase()] ?? null;
}

export function langOf(grammar: Grammar): Lang {
  return grammar === 'tsx' ? 'typescript' : grammar;
}

const require = createRequire(import.meta.url);

/** Resolves via package.json so it works from src (vitest) and from dist. */
export function grammarWasmPath(grammar: Grammar): string {
  const pkg = require.resolve('tree-sitter-wasms/package.json');
  return join(dirname(pkg), 'out', `tree-sitter-${grammar}.wasm`);
}

let initPromise: Promise<void> | undefined;
const parsers = new Map<Grammar, Promise<Parser>>();

function init(): Promise<void> {
  initPromise ??= Parser.init({
    locateFile: (name: string) => (name.endsWith('.wasm') ? require.resolve('web-tree-sitter/tree-sitter.wasm') : name),
  });
  return initPromise;
}

/** One cached parser per grammar. Parsing is synchronous, so sharing is safe. */
export function getParser(grammar: Grammar): Promise<Parser> {
  let p = parsers.get(grammar);
  if (!p) {
    p = (async () => {
      await init();
      const language = await Language.load(grammarWasmPath(grammar));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parsers.set(grammar, p);
  }
  return p;
}
