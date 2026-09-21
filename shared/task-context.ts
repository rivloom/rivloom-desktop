/** Metadata only: prompt bodies, credentials and absolute engine paths are not exposed. */
export type ContextSource = { kind: 'policy' | 'knowledge-guide' | 'project-rules' | 'account-history' | 'request' | 'attachment';
  inclusion: 'system' | 'message' | 'reference'; revision: string; bytes: number; reference?: string };
export type ContextObservation = {
  at: string; messageID: string; agent: string; model: string;
  kind: 'execution' | 'compaction'; system: 'matched' | 'restored' | 'mismatch' | 'not_applicable';
  /** Runtime-selected history before provider serialization; not a token count. */
  selectedMessages?: number; summaryIDs?: string[];
};
export type TaskContextRecord = {
  schemaVersion: 1; id: string; taskID: string; projectID: string; sessionID: string; runAfter: number;
  accountID: string; createdAt: string; systemRevision: string; sources: ContextSource[];
  observationCount: number; observations: ContextObservation[];
};
