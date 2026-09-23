import type { AskResult } from './ask.js';
import { winningOption } from './engine/answer.js';
import { formatDelta } from './explain/summary.js';
import { spanLabel } from './scope.js';
import type { Answer, ExplainBlock } from './types.js';

/** YES / NO, the chosen option key, or "level 2: high". */
export function answerLabel(answer: Answer): string {
  switch (answer.type) {
    case 'yesno':
      return answer.p >= 0.5 ? 'YES' : 'NO';
    case 'choice':
      return answer.choice;
    case 'score': {
      const level = winningOption(answer);
      return `level ${level}: ${answer.legend[level] ?? ''}`.trim();
    }
  }
}

/** Probability of the shown answer (P(no) for a NO). */
export function answerP(answer: Answer): number {
  switch (answer.type) {
    case 'yesno':
      return Math.max(answer.p, 1 - answer.p);
    case 'choice':
    case 'score':
      return answer.probabilities[winningOption(answer)] ?? 0;
  }
}

function headline(r: AskResult): string {
  const a = r.answer;
  const label = a.type === 'score' ? `SCORE ${a.score.toFixed(2)}/${Object.keys(a.probabilities).length - 1} (${answerLabel(a)})` : answerLabel(a);
  return `${label}  p=${answerP(a).toFixed(2)}  conf=${a.confidence.toFixed(2)}  ${a.band}   ${JSON.stringify(r.question.instructions)}`;
}

/** Summary, highlights, reasons and why of an explanation, as readable lines. */
export function explainLines(ex: ExplainBlock): string[] {
  const out: string[] = [];
  if (ex.summary.length) out.push('summary', ...ex.summary.map((l) => `  ${l}`));
  if (ex.highlights.length) {
    const spans = ex.highlights.map((h) => spanLabel(h.file, h.startLine, h.endLine));
    const width = Math.max(...spans.map((s) => s.length));
    out.push('highlights');
    ex.highlights.forEach((h, i) => {
      out.push(`  ${spans[i]!.padEnd(width)}   Δp ${formatDelta(h.deltaP)}${h.comment ? `  # ${h.comment}` : ''}`);
    });
  } else if (ex.stats) {
    out.push('highlights', '  none above the threshold');
  }
  if (ex.reasons.length) {
    const width = Math.max(...ex.reasons.map((x) => x.code.length));
    out.push('reasons', ...ex.reasons.map((x) => `  ${x.code.padEnd(width)}   p=${x.p.toFixed(2)}`));
  }
  if (ex.why) out.push(`why  ${ex.why.text}   (narrative, not checked)`);
  return out;
}

/**
 * "2 calls" or "2 calls x 3 samples = 6 model runs": host CLI backends start one
 * process per sample, so the product is what latency and quota follow.
 */
export function callsText(calls: number, samples?: number, label = 'call'): string {
  const base = `${calls} ${label}${calls === 1 ? '' : 's'}`;
  return samples && samples > 1 && calls > 0 ? `${base} x ${samples} samples = ${calls * samples} model runs` : base;
}

/** The human-readable output shown in the plan. */
export function renderPretty(r: AskResult): string {
  const out = [headline(r)];
  const a = r.answer;
  if (a.type !== 'yesno') {
    out.push(`options  ${Object.entries(a.probabilities).map(([k, p]) => `${k} ${p.toFixed(2)}`).join('   ')}`);
  }
  if (r.explain) out.push(...explainLines(r.explain));
  else if (r.explainStats) out.push('highlights', '  none above the threshold');

  // The why is one free-text call; decide and explain calls are sampled.
  const sampled = r.calls.decide + r.calls.explain;
  const parts = [`${r.calls.decide} call${r.calls.decide === 1 ? '' : 's'}`];
  if (r.calls.explain) parts.push(`${r.calls.explain} explain`);
  if (r.samples && r.samples > 1) parts[parts.length - 1] += ` (x ${r.samples} samples = ${sampled * r.samples} model runs)`;
  if (r.calls.why) parts.push(`${r.calls.why} why`);
  const stats = r.explainStats;
  const tested = stats ? `, ${stats.tested}/${stats.candidates} spans tested` : '';
  out.push(`cost  ${parts.join(' + ')}${tested}, ${(r.latencyMs / 1000).toFixed(1)} s, ${r.backend}${r.model ? ` (${r.model})` : ''}`);
  if (r.record.id) out.push(`id    ${r.record.id}   (glassbox explain ${r.record.id})`);
  return out.join('\n');
}

/** Machine-readable output: the answer, explanation and cost, without the chunk texts. */
export function renderJson(r: AskResult): string {
  return JSON.stringify(
    {
      question: r.question,
      answer: r.answer,
      label: answerLabel(r.answer),
      ...(r.explain ? { explain: r.explain } : {}),
      ...(r.explainStats ? { explainStats: r.explainStats } : {}),
      calls: r.calls,
      latencyMs: r.latencyMs,
      backend: r.backend,
      ...(r.model ? { model: r.model } : {}),
      stateHash: r.record.stateHash,
      ...(r.record.id ? { id: r.record.id } : {}),
      scope: r.chunks.map((c) => spanLabel(c.file, c.startLine, c.endLine)),
      ...(r.logFile ? { logFile: r.logFile } : {}),
    },
    null,
    2,
  );
}
