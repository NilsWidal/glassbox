// Shared contracts. Other modules (backends, explain, graph, memory, mcp, cli)
// build on these, so change them only in backward-compatible ways.

// ---------------------------------------------------------------------------
// State and questions
// ---------------------------------------------------------------------------

/** What the questions are about: raw text, or a JSON-serializable object. */
export type State = string | { readonly [key: string]: unknown };

export type QuestionType = 'yesno' | 'choice' | 'score';

/** Confidence thresholds. `act` if confidence >= act, `confirm` if >= confirm, else `escalate`. */
export interface BandThresholds {
  act: number;
  confirm: number;
}

export type Band = 'act' | 'confirm' | 'escalate';

interface QuestionBase {
  /** What to decide. May reference parts of the state, e.g. `ticket.messages[0].text`. */
  instructions: string;
  /** Per-question band thresholds; defaults are act >= 0.85, confirm >= 0.6. */
  bands?: Partial<BandThresholds>;
}

export interface YesNoQuestion extends QuestionBase {
  type: 'yesno';
  /** Optional descriptions of what "true" and "false" mean. */
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion extends QuestionBase {
  type: 'choice';
  /** Option key -> description. At least 2 options. */
  criteria: Record<string, string>;
}

export interface ScoreQuestion extends QuestionBase {
  type: 'score';
  /** Ordered levels, lowest first. 2 to 10 levels. Level i has value i. */
  criteria: string[];
}

export type Question = YesNoQuestion | ChoiceQuestion | ScoreQuestion;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

interface AnswerBase {
  /** (K * pmax - 1) / (K - 1), in [0, 1]. K is the number of options. */
  confidence: number;
  band: Band;
}

export interface YesNoAnswer extends AnswerBase {
  type: 'yesno';
  /** P(true). */
  p: number;
}

export interface ChoiceAnswer extends AnswerBase {
  type: 'choice';
  /** The most probable option key. */
  choice: string;
  /** Option key -> probability, sums to 1. */
  probabilities: Record<string, number>;
}

export interface ScoreAnswer extends AnswerBase {
  type: 'score';
  /** Probability-weighted expected level, in [0, levels - 1]. */
  score: number;
  /** Level index as a string ("0", "1", ...) -> level description. */
  legend: Record<string, string>;
  /** Level index as a string -> probability, sums to 1. */
  probabilities: Record<string, number>;
}

export type Answer = YesNoAnswer | ChoiceAnswer | ScoreAnswer;

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export type BackendName = 'auto' | 'claude-cli' | 'codex-cli' | 'anthropic' | 'openai-compat' | 'fake';

/**
 * One question as sent to a backend. `labels[i]` is the single-token label
 * (A, B, C, ...) shown for option key `options[i]`. Option keys are
 * 'true'/'false' for yesno, criteria keys for choice, and level indexes
 * ("0", "1", ...) for score. The order may be shuffled by the engine.
 */
export interface BatchQuestion {
  question: Question;
  labels: string[];
  options: string[];
}

/** Label -> probability. Need not be normalized; the engine normalizes. */
export type LabelDistribution = Record<string, number>;

export interface BackendCapabilities {
  /** True when probabilities come from token logprobs rather than stated or sampled. */
  hasLogprobs: boolean;
  /** True when answerBatch can answer many questions in one call. */
  batch: boolean;
  /** True when `generate` is implemented (used for the lazy one-line why). */
  generate?: boolean;
}

export interface GenerateOptions {
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Backend {
  readonly name: string;
  /** Model id in use, if known. */
  readonly model?: string;
  /** The model and where it came from, for status and cost lines, e.g. "opus[1m] from ~/.claude/settings.json". */
  readonly modelSource?: string;
  /** Model runs averaged per call (host CLIs start one process each), when more than one. */
  readonly samples?: number;
  /** Most requests one call can send, retries included (HTTP backends that retry). Default 1. */
  readonly maxRequestsPerCall?: number;
  /** Requests sent so far, retries included, for backends that count them. */
  readonly requestCount?: number;
  readonly capabilities: BackendCapabilities;
  /**
   * Answers every question about one state in ONE call (host CLI calls are
   * slow, so batching is the primary path). Returns question id -> label
   * distribution. Use buildBatchPrompt / buildAnswerSchema from the engine.
   */
  answerBatch(
    state: State,
    questions: Record<string, BatchQuestion>,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, LabelDistribution>>;
  /** Free-text generation, only when capabilities.generate is true. */
  generate?(prompt: string, opts?: GenerateOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export type Calibrator =
  | { kind: 'identity' }
  /** Divides log-probabilities by T, then renormalizes. T > 1 softens, T < 1 sharpens. */
  | { kind: 'temperature'; T: number }
  /** sigmoid(a * logit(p) + b) per option, then renormalized when K > 2. */
  | { kind: 'platt'; a: number; b: number };

// ---------------------------------------------------------------------------
// Decisions and the JSONL log
// ---------------------------------------------------------------------------

export interface DecideOptions {
  /** Option orders to average over (>= 1). Default 2: original plus reversed. */
  permutations?: number;
  /** Per question id calibrator, applied after averaging. */
  calibrators?: Record<string, Calibrator>;
  /** Default thresholds for questions without their own `bands`. */
  bands?: Partial<BandThresholds>;
  /** Seed for permutations beyond the second. */
  seed?: number;
  signal?: AbortSignal;
}

export interface DecisionRecord {
  /** Short id for `glassbox explain <id>`; set when the record is logged. */
  id?: string;
  /** ISO timestamp. */
  ts: string;
  /** sha256 of the stable serialization of the state. */
  stateHash: string;
  questionId: string;
  question: Question;
  backend: string;
  model?: string;
  /** Option key -> probability, averaged over permutations, before calibration. */
  raw: Record<string, number>;
  /** Option key -> probability after calibration (equals raw when none applied). */
  calibrated: Record<string, number>;
  calibrator?: Calibrator;
  answer: Answer;
  /** Number of option orders averaged. */
  permutations: number;
  latencyMs: number;
  explain?: ExplainBlock;
  /** Human ground truth (an option key), added later for calibration. */
  truth?: string;
  /**
   * What was asked about, so the decision can be explained later. A diff is
   * stored as its file list and sha256 (never its text, which may hold
   * secrets); `diff` itself appears only in logs written by older versions.
   * `context` is the hint a `decide` call was given.
   */
  scope?: { paths?: string[]; diff?: string; diffFiles?: string[]; diffHash?: string; nodes?: string[]; context?: string };
  /** Which command made the record. Absent means `ask`. */
  source?: 'ask' | 'triage' | 'decide';
}

export interface DecideResult {
  stateHash: string;
  answers: Record<string, Answer>;
  records: DecisionRecord[];
  /** Backend calls made (one per permutation when the backend batches). */
  calls: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Explanations
// ---------------------------------------------------------------------------

/**
 * `causal`: measured by re-asking (hiding evidence moved the probability).
 * `narrative`: generated text, not checked against the model's behavior.
 */
export type EvidenceKind = 'causal' | 'narrative';

export interface Highlight {
  file: string;
  startLine: number;
  endLine: number;
  /** p(with span hidden) - p(original) for the chosen answer. Negative means the span supported it. */
  deltaP: number;
  /** Optional one-line narrative comment. */
  comment?: string;
  kind: 'causal';
}

export interface ReasonCode {
  code: string;
  /** P(reason applies), asked as a hidden yes/no question. */
  p: number;
  kind: 'causal';
}

export interface ExplainBlock {
  highlights: Highlight[];
  reasons: ReasonCode[];
  /** Pseudo-code lines built only from highlights and reason codes. */
  summary: string[];
  /** Lazy generated "why", at most 12 words. */
  why?: { text: string; kind: 'narrative' };
  /** What the hide-and-re-ask pass cost and covered, when it ran. */
  stats?: ExplainStats;
}

export interface ExplainStats {
  /** Backend calls spent on explanation (prefilter, reasons and re-asks). */
  calls: number;
  /** Chunks the prefilter picked for re-asking. */
  candidates: number;
  /** Chunks actually hidden and re-asked within the budget. */
  tested: number;
  /** P(chosen option) on the full state that each deltaP is measured against. */
  baselineP: number;
}

// ---------------------------------------------------------------------------
// Memory graph
// ---------------------------------------------------------------------------

export type NodeKind = 'file' | 'function' | 'class' | 'method';

export interface GraphNode {
  /** Stable id, e.g. "src/auth/session.ts#verifySession". */
  id: string;
  kind: NodeKind;
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  /** Content hash of the node's source text. */
  hash: string;
  lang: string;
}

export type EdgeKind = 'imports' | 'calls' | 'contains';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Tag {
  nodeId: string;
  questionId: string;
  /** Winning option key ('true'/'false', a choice key, or a level index). */
  answer: string;
  /** Probability of `answer`. */
  p: number;
  confidence: number;
  /** Node content hash when tagged; a mismatch means the tag is stale. */
  hash: string;
}

/** Short aliases matching the plan's names. */
export type Node = GraphNode;
export type Edge = GraphEdge;
