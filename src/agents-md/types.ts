/** A codebase area shown in the AGENTS.md block. */
export interface AreaSummary {
  name: string;
  /** Entry points as `file:line`. */
  entryPoints: string[];
  nodeCount: number;
}

/** A risky or high-impact node shown in the AGENTS.md block. */
export interface RiskyNode {
  name: string;
  file: string;
  line: number;
  reason: string;
  /** Probability the node is risky, in [0, 1]. */
  p: number;
}

/** What the indexer hands to syncAgentsMd. */
export interface AgentsMdSummary {
  areas: AreaSummary[];
  riskyNodes: RiskyNode[];
  availableTags: string[];
  /** ISO timestamp of the index run. */
  generatedAt: string;
}

export interface SyncAgentsMdOptions {
  /** false: never create CLAUDE.md (an existing one still gets the import). Default true. */
  claudeMd?: boolean;
  /** Hard cap on block lines, markers included. Default 60. */
  maxLines?: number;
}

export type FileAction = 'created' | 'updated' | 'unchanged' | 'skipped';

export interface SyncAgentsMdResult {
  agentsMdPath: string;
  claudeMdPath: string;
  agentsMd: FileAction;
  claudeMd: FileAction;
  /** True when areas, nodes or tags were cut to fit the cap. */
  truncated: boolean;
  lines: number;
}
