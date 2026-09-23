import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Set by scripts/bundle.mjs (esbuild `define`) in the single-file plugin
 * bundle, plugin-dist/glassbox.mjs. Undefined when running from src/ or dist/.
 */
declare const __GLASSBOX_BUNDLE__: { version: string } | undefined;

export const BUNDLE: { version: string } | undefined = typeof __GLASSBOX_BUNDLE__ === 'undefined' ? undefined : __GLASSBOX_BUNDLE__;

/** Directory of the plugin bundle (its wasm files sit next to it), or undefined outside the bundle. */
export function bundleDir(): string | undefined {
  return BUNDLE ? dirname(fileURLToPath(import.meta.url)) : undefined;
}

/** The package version: baked into the bundle, else read from package.json (src/ and dist/ are both two levels down). */
export function packageVersion(): string {
  if (BUNDLE) return BUNDLE.version;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
