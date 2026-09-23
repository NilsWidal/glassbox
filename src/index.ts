export * from './types.js';
export * from './engine/index.js';
export { DEFAULT_MODELS, isBackendName, resolveBackendName, resolveModel } from './config.js';
export { FakeBackend, createFakeBackend, fixedAnswer, whenContains } from './backends/fake.js';
export type { FakeBackendOptions, FakeCall, FakeRule, FakeRuleContext, FakeRuleResult } from './backends/fake.js';
export { hashState, sha256, stateText } from './util/hash.js';
export { stableStringify } from './util/json.js';
export { DECISION_LOG, appendDecisionLog, ask, makeQuestion } from './ask.js';
export type { AskExplainOptions, AskOptions, AskResult } from './ask.js';
export * from './explain/index.js';
export { buildScope, chunkDiff, chunkHeader, chunkText, renderState, spanLabel } from './scope.js';
export type { AskScope, BuildScopeOptions, Chunk, ScopeResult } from './scope.js';
export { answerLabel, answerP, renderJson, renderPretty } from './render.js';
export { createBackend, resolveBackend } from './backends/index.js';
export type { BackendConfig } from './backends/index.js';
export { decisionId, readDecisionLog } from './ask.js';
// The store (node:sqlite) is not re-exported here so importing the package never loads it.
export type { GraphStore, StoredNode, SyncResult } from './memory/store.js';
export { SourceCache, indexRepo, tagLabel, type IndexResult } from './memory/source.js';
export {
  DEFAULT_GROUP_SIZE,
  DEFAULT_TAG_CONCURRENCY,
  OTHER_AREA,
  RISK_LEVELS,
  areaOf,
  defaultTagQuestions,
  inferAreas,
  isTagTarget,
  nodeTagLabels,
  tagPass,
  tagsFresh,
  type TagPassOptions,
  type TagPassResult,
  type TagProgress,
} from './memory/tags.js';
export { buildAgentsSummary, syncMd } from './memory/summary.js';
export * from './query/index.js';
