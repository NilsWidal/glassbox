// Helpers for checks on the TypeScript fixture. Node runs the .ts files with type
// stripping; this adds one resolve rule so `./x.js` finds `./x.ts`, as tsc would.
/* global process, console */
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hook = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.endsWith('.js') && context.parentURL) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    throw err;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

/** Imports a workspace file; `fresh` re-evaluates it (its own top-level code runs again). */
export async function load(rel, fresh = '') {
  const file = join(process.cwd(), rel);
  if (!existsSync(file)) fail(`${rel} is missing`);
  return import(pathToFileURL(file).href + (fresh ? `?${fresh}` : ''));
}

export function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

export function check(cond, msg) {
  if (!cond) fail(msg);
}
