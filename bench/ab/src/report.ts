// Summaries and the readable results table.
import type { Arm } from './agents.ts';
import type { PrepRecord, RunRecord } from './runner.ts';

export interface ResultsFile {
  label: string;
  date: string;
  agent: string;
  model?: string;
  agentVersion?: string;
  glassboxVersion?: string;
  arms: Arm[];
  repeats: number;
  caveats: string[];
  settings: Record<string, unknown>;
  prep: PrepRecord[];
  runs: RunRecord[];
  summary: Summary;
}

export const METRICS = ['costUsd', 'totalTokens', 'outputTokens', 'toolCalls', 'numTurns', 'wallMs', 'answerWords', 'answerChars'] as const;
export type MetricName = (typeof METRICS)[number];

export function metricOf(r: RunRecord, m: MetricName): number | undefined {
  switch (m) {
    case 'wallMs':
      return r.wallMs;
    case 'answerWords':
      return r.answerWords;
    case 'answerChars':
      return r.answerChars;
    case 'toolCalls':
      return r.metrics.toolCalls;
    default:
      return r.metrics[m];
  }
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function mean(xs: number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

export interface ArmSummary {
  arm: Arm;
  runs: number;
  successes: number;
  /** Runs the agent CLI itself reported as failed (errors, timeouts, budget stops). */
  agentErrors: number;
  median: Partial<Record<MetricName, number>>;
  mean: Partial<Record<MetricName, number>>;
  /** Sum of costUsd over the arm's runs. */
  totalCostUsd?: number;
}

export interface PairedSummary {
  /** Tasks run in both arms. */
  tasks: number;
  /** Tasks where the ambient arm passed more often than the baseline, and the other way round. */
  ambientOnlyPass: number;
  baselineOnlyPass: number;
  /**
   * Per metric: the median over tasks of (ambient mean - baseline mean), and on how many
   * tasks ambient was lower, higher or equal. Lower is cheaper, faster or shorter.
   */
  deltas: Partial<Record<MetricName, { medianDelta: number; ambientLower: number; ambientHigher: number; equal: number; tasks: number }>>;
}

export interface Summary {
  arms: ArmSummary[];
  paired?: PairedSummary;
}

export function summarize(runs: RunRecord[], arms: Arm[]): Summary {
  const out: Summary = { arms: [] };
  for (const arm of arms) {
    const rs = runs.filter((r) => r.arm === arm);
    const s: ArmSummary = {
      arm,
      runs: rs.length,
      successes: rs.filter((r) => r.success).length,
      agentErrors: rs.filter((r) => r.error !== undefined).length,
      median: {},
      mean: {},
    };
    for (const m of METRICS) {
      const xs = rs.map((r) => metricOf(r, m)).filter((x): x is number => x !== undefined);
      const med = median(xs);
      const avg = mean(xs);
      if (med !== undefined) s.median[m] = med;
      if (avg !== undefined) s.mean[m] = avg;
    }
    const costs = rs.map((r) => r.metrics.costUsd).filter((x): x is number => x !== undefined);
    if (costs.length) s.totalCostUsd = costs.reduce((a, b) => a + b, 0);
    out.arms.push(s);
  }
  if (arms.includes('ambient') && arms.includes('baseline')) out.paired = paired(runs);
  return out;
}

function paired(runs: RunRecord[]): PairedSummary {
  const ids = [...new Set(runs.map((r) => r.taskId))];
  const res: PairedSummary = { tasks: 0, ambientOnlyPass: 0, baselineOnlyPass: 0, deltas: {} };
  const perMetric = new Map<MetricName, number[]>();
  for (const id of ids) {
    const a = runs.filter((r) => r.taskId === id && r.arm === 'ambient');
    const b = runs.filter((r) => r.taskId === id && r.arm === 'baseline');
    if (!a.length || !b.length) continue;
    res.tasks++;
    const rate = (rs: RunRecord[]) => rs.filter((r) => r.success).length / rs.length;
    if (rate(a) > rate(b)) res.ambientOnlyPass++;
    if (rate(b) > rate(a)) res.baselineOnlyPass++;
    for (const m of METRICS) {
      const ma = mean(a.map((r) => metricOf(r, m)).filter((x): x is number => x !== undefined));
      const mb = mean(b.map((r) => metricOf(r, m)).filter((x): x is number => x !== undefined));
      if (ma === undefined || mb === undefined) continue;
      const list = perMetric.get(m) ?? [];
      list.push(ma - mb);
      perMetric.set(m, list);
    }
  }
  for (const [m, ds] of perMetric) {
    res.deltas[m] = {
      medianDelta: median(ds) as number,
      ambientLower: ds.filter((d) => d < 0).length,
      ambientHigher: ds.filter((d) => d > 0).length,
      equal: ds.filter((d) => d === 0).length,
      tasks: ds.length,
    };
  }
  return res;
}

const fmt = (m: MetricName, v: number | undefined): string => {
  if (v === undefined) return 'n/a';
  if (m === 'costUsd') return `$${v.toFixed(4)}`;
  if (m === 'wallMs') return `${(v / 1000).toFixed(1)} s`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
};

const fmtDelta = (m: MetricName, v: number): string => {
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${fmt(m, Math.abs(v))}`;
};

const LABELS: Record<MetricName, string> = {
  costUsd: 'cost',
  totalTokens: 'tokens (all)',
  outputTokens: 'output tokens',
  toolCalls: 'tool calls',
  numTurns: 'turns',
  wallMs: 'wall time',
  answerWords: 'answer words',
  answerChars: 'answer chars',
};

export function renderMarkdown(r: ResultsFile): string {
  const lines: string[] = [];
  lines.push(`# A/B results: ${r.label}`);
  lines.push('');
  lines.push(`- Date: ${r.date}`);
  lines.push(`- Agent: ${r.agent}${r.agentVersion ? ` (${r.agentVersion})` : ''}, model: ${r.model ?? 'CLI default'}`);
  if (r.glassboxVersion) lines.push(`- glassbox: ${r.glassboxVersion}`);
  lines.push(`- Arms: ${r.arms.join(', ')}; repeats per task and arm: ${r.repeats}; tasks: ${new Set(r.runs.map((x) => x.taskId)).size}`);
  lines.push('');
  if (r.caveats.length) {
    lines.push('## Caveats');
    lines.push('');
    for (const c of r.caveats) lines.push(`- ${c}`);
    lines.push('');
  }
  lines.push('## Per arm');
  lines.push('');
  lines.push(`| arm | runs | passed | agent errors | ${METRICS.map((m) => `median ${LABELS[m]}`).join(' | ')} | total cost |`);
  lines.push(`|---|---|---|---|${METRICS.map(() => '---').join('|')}|---|`);
  for (const a of r.summary.arms) {
    lines.push(
      `| ${a.arm} | ${a.runs} | ${a.successes}/${a.runs} | ${a.agentErrors} | ${METRICS.map((m) => fmt(m, a.median[m])).join(' | ')} | ${fmt('costUsd', a.totalCostUsd)} |`,
    );
  }
  lines.push('');
  const p = r.summary.paired;
  if (p) {
    lines.push('## Paired by task (ambient minus baseline)');
    lines.push('');
    lines.push(`${p.tasks} tasks ran in both arms. Ambient passed where the baseline failed on ${p.ambientOnlyPass}; the baseline passed where ambient failed on ${p.baselineOnlyPass}.`);
    lines.push('');
    lines.push('| metric | median difference | ambient lower | ambient higher | equal |');
    lines.push('|---|---|---|---|---|');
    for (const m of METRICS) {
      const d = p.deltas[m];
      if (!d) continue;
      lines.push(`| ${LABELS[m]} | ${fmtDelta(m, d.medianDelta)} | ${d.ambientLower} | ${d.ambientHigher} | ${d.equal} |`);
    }
    lines.push('');
  }
  lines.push('## Per run');
  lines.push('');
  lines.push('| task | arm | rep | pass | cost | tokens | tool calls | turns | wall | words | ambient chars | error |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of r.runs) {
    lines.push(
      `| ${x.taskId} | ${x.arm} | ${x.repeat} | ${x.success ? 'yes' : 'no'} | ${fmt('costUsd', x.metrics.costUsd)} | ${fmt('totalTokens', x.metrics.totalTokens)} | ${x.metrics.toolCalls} | ${fmt('numTurns', x.metrics.numTurns)} | ${fmt('wallMs', x.wallMs)} | ${x.answerWords} | ${x.metrics.ambientChars ?? '-'} | ${x.error ? x.error.replaceAll('|', '/').slice(0, 80) : ''} |`,
    );
  }
  lines.push('');
  if (r.prep.length) {
    lines.push('## Preparation (not counted in the runs)');
    lines.push('');
    for (const p2 of r.prep) {
      lines.push(`- ${p2.repo}: \`glassbox init\` for the ambient arm, ${p2.ok ? 'ok' : 'failed'}, ${(p2.wallMs / 1000).toFixed(1)} s${p2.detail ? ` (${p2.detail})` : ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
