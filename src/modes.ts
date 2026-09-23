import { bandFor, resolveBands } from './engine/bands.js';
import { loadProjectConfig } from './project-config.js';
import type { Band, BandThresholds, Calibrator, DecideOptions } from './types.js';

/**
 * How much work one glassbox call does:
 *
 * - fast: one sample, one option order, no evidence and no generated why.
 * - balanced: the defaults (2 option orders, the backend's samples, evidence only when asked).
 * - explained: balanced plus the hide-and-re-ask evidence and the one-line why.
 * - strict: more samples and option orders, evidence, and higher band thresholds.
 * - auto: fast first; when the answer's band is not `act`, asked again in explained.
 */
export const MODES = ['fast', 'balanced', 'explained', 'strict', 'auto'] as const;
export type Mode = (typeof MODES)[number];
export type ConcreteMode = Exclude<Mode, 'auto'>;

export interface ModeSettings {
  /** Model runs averaged per call (host CLI and Anthropic backends). */
  samples?: number;
  /** Option orders averaged per question. */
  permutations?: number;
  /** Hide-and-re-ask evidence. Undefined keeps the command's own default. */
  explain?: boolean;
  /** One-line why. Undefined keeps the default (only below the act band). */
  why?: boolean;
  /** Default band thresholds for questions without their own. */
  bands?: Partial<BandThresholds>;
}

export const MODE_SETTINGS: Readonly<Record<ConcreteMode, Readonly<ModeSettings>>> = Object.freeze({
  fast: { samples: 1, permutations: 1, explain: false, why: false },
  balanced: {},
  explained: { explain: true, why: true },
  strict: { samples: 5, permutations: 3, explain: true, why: true, bands: { act: 0.9, confirm: 0.7 } },
});

export function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

export type ModeSource = 'call' | 'env' | 'project' | 'plugin' | 'default';

export interface ResolvedMode {
  mode: Mode;
  /** Where the mode came from; `default` means nothing set one (balanced, the v0.1 behavior). */
  source: ModeSource;
}

function checked(v: string, where: string): Mode {
  const t = v.trim();
  if (!isMode(t)) throw new Error(`unknown mode "${t}" in ${where}; expected one of ${MODES.join(', ')}`);
  return t;
}

/**
 * The mode for one call, first set wins: the call itself (MCP `mode`, CLI
 * `--mode`), GLASSBOX_MODE, `mode` in <root>/.glassbox/config.json, the Claude
 * Code plugin option (CLAUDE_PLUGIN_OPTION_MODE), else balanced.
 */
export function resolveMode(opts: { explicit?: string | undefined; env: NodeJS.ProcessEnv; root?: string }): ResolvedMode {
  if (opts.explicit?.trim()) return { mode: checked(opts.explicit, 'the call'), source: 'call' };
  const env = opts.env.GLASSBOX_MODE;
  if (env?.trim()) return { mode: checked(env, 'GLASSBOX_MODE'), source: 'env' };
  if (opts.root) {
    const project = loadProjectConfig(opts.root).mode;
    if (project?.trim()) return { mode: checked(project, '.glassbox/config.json'), source: 'project' };
  }
  const plugin = opts.env.CLAUDE_PLUGIN_OPTION_MODE;
  if (plugin?.trim()) return { mode: checked(plugin, 'the plugin option "mode"'), source: 'plugin' };
  return { mode: 'balanced', source: 'default' };
}

export interface ModeRun<R> {
  result: R;
  /** The mode the returned result was made in. */
  used: ConcreteMode;
  /** Set when auto asked again: the band of the fast answer that triggered it. */
  escalated?: { from: ConcreteMode; band: Band };
}

/** What a mode run reports alongside its result. */
export interface ModeReport {
  requested: Mode;
  source: ModeSource;
  used: ConcreteMode;
  escalated?: { from: ConcreteMode; band: Band };
}

/**
 * Runs `run` in the resolved mode. auto runs fast first, then explained when
 * `bandOf` says the fast result is not `act`.
 */
export async function runWithMode<R>(
  mode: Mode,
  run: (m: ConcreteMode, settings: Readonly<ModeSettings>) => Promise<R>,
  bandOf: (r: R) => Band | undefined,
): Promise<ModeRun<R>> {
  if (mode !== 'auto') return { result: await run(mode, MODE_SETTINGS[mode]), used: mode };
  const first = await run('fast', MODE_SETTINGS.fast);
  const band = bandOf(first);
  if (band === undefined || band === 'act') return { result: first, used: 'fast' };
  return { result: await run('explained', MODE_SETTINGS.explained), used: 'explained', escalated: { from: 'fast', band } };
}

export function modeReport<R>(resolved: ResolvedMode, run: ModeRun<R>): ModeReport {
  return { requested: resolved.mode, source: resolved.source, used: run.used, ...(run.escalated ? { escalated: run.escalated } : {}) };
}

/** One text line for the readable output, or '' for balanced (the default behavior, however it was chosen). */
export function renderModeLine(r: ModeReport): string {
  if (r.requested === 'balanced') return '';
  if (r.requested !== 'auto') return `mode   ${r.used}`;
  return r.escalated
    ? `mode   auto: ${r.escalated.from} gave band ${r.escalated.band}, asked again in ${r.used}`
    : `mode   auto: ${r.used} (band act)`;
}

/** Band of a `where` result: the top hit's confidence (|2p - 1|) against the mode's thresholds. */
export function whereBand(topP: number | undefined, bands?: Partial<BandThresholds>): Band | undefined {
  if (topP === undefined) return undefined;
  return bandFor(Math.abs(2 * topP - 1), resolveBands(undefined, bands));
}

/**
 * Decide options for a mode: an explicit permutation count wins over the
 * mode's, and the mode's band thresholds apply to questions without their
 * own. Undefined when there is nothing to set.
 */
export function modeDecideOptions(
  s: Readonly<ModeSettings>,
  permutations?: number,
  calibrators?: Record<string, Calibrator>,
): DecideOptions | undefined {
  const perms = permutations ?? s.permutations;
  const has = calibrators && Object.keys(calibrators).length > 0;
  if (perms === undefined && !s.bands && !has) return undefined;
  return {
    ...(perms !== undefined ? { permutations: perms } : {}),
    ...(s.bands ? { bands: { ...s.bands } } : {}),
    ...(has ? { calibrators } : {}),
  };
}

/** Adds the mode report to a JSON result unless the mode is balanced. */
export function withModeJson<T extends object>(value: T, report: ModeReport): T & { mode?: ModeReport } {
  return renderModeLine(report) ? { ...value, mode: report } : value;
}

/** Appends the mode line to a readable result unless the mode is balanced. */
export function withModeText(text: string, report: ModeReport): string {
  const line = renderModeLine(report);
  return line ? `${text}\n${line}` : text;
}
