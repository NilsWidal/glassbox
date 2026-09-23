#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Placeholder entry point; subcommands (init, index, ask, where, triage,
// decide, explain, calibrate, sync-md, mcp) are added in later milestones.

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `glassbox ${version()}
Fast typed decisions about code, with reasons.

Usage: glassbox <command> [options]

Commands are not implemented yet in this build.
Options:
  -h, --help      show this help
  -v, --version   print the version
`;

export function main(argv: string[]): number {
  const [cmd] = argv;
  if (cmd === '-v' || cmd === '--version') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  process.stderr.write(`glassbox: unknown command "${cmd}"\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
