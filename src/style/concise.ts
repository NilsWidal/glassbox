import { featureEnabled, type ProjectConfig } from '../project-config.js';

/**
 * The concise answer rules. The Claude Code output style
 * (output-styles/concise.md) and the optional AGENTS.md section both carry
 * this exact text; a test keeps them in step.
 */
export const CONCISE_RULES: readonly string[] = [
  'Lead with the answer or the result. No preamble.',
  'Cite code as `file:line` (or `file:start-end`) instead of pasting it.',
  'Never paste code that did not change. When a snippet helps, show only the changed lines.',
  'Give each reason in one line.',
  'No closing recap of what you did, and no restating the request.',
  'Say in one line what you did not check, when it matters.',
];

export const CONCISE_HEADING = '### Answer style';

/** The AGENTS.md section: a heading plus one bullet per rule. */
export function conciseSection(): string[] {
  return [CONCISE_HEADING, ...CONCISE_RULES.map((r) => `- ${r}`)];
}

/**
 * Whether the AGENTS.md block carries the concise rules. Off by default. On
 * with GLASSBOX_CONCISE_RULES=1, `"conciseRules": true` in .glassbox/config.json,
 * or the plugin's concise_rules option, first set wins.
 */
export function conciseRulesEnabled(env: NodeJS.ProcessEnv, config: ProjectConfig): boolean {
  return featureEnabled(env, { env: 'GLASSBOX_CONCISE_RULES', plugin: 'CLAUDE_PLUGIN_OPTION_CONCISE_RULES' }, config.conciseRules, false);
}
