/** Local execution activity only. No task titles, prompts, paths or error bodies are exposed. */
export type NodeModelActivityCounts = {
  active: number;
  generating: number;
  tools: number;
  waiting: number;
  failed: number;
};

export type NodeModelActivityRates = {
  /** Newly confirmed engine input usage / 60 seconds, not model prefill speed. */
  inputTokensPerSecond: number | null;
  /** Estimated text + reasoning delta tokens / 3 seconds. Excludes tool output. */
  outputTokensPerSecond: number | null;
};

export type NodeModelActivityConnection = NodeModelActivityRates & {
  id: string;
  name: string;
  providerName: string;
  countsComplete: boolean;
  counts: NodeModelActivityCounts;
};

export type NodeModelActivitySnapshot = NodeModelActivityRates & {
  sampledAt: number;
  inputWindowSeconds: 60;
  outputWindowSeconds: 3;
  inputComplete: boolean;
  outputComplete: boolean;
  countsComplete: boolean;
  /** Bounded observation capacity was exceeded; totals must not imply full coverage. */
  limited: boolean;
  counts: NodeModelActivityCounts;
  connections: NodeModelActivityConnection[];
};
