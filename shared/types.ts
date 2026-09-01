export type TaskState =
  | 'open'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'stopping'
  | 'stopped'
  | 'interrupted'
  | 'failed'
  | 'review'
  | 'accepted';
export type User = { id: string; username: string; name: string; owner: boolean };
export type Project = { id: string; name: string; directory: string; createdAt: string };
export type Artifact = {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
};
export type Activity = {
  id: number;
  taskID: string;
  actorID: string | null;
  kind: string;
  text: string;
  at: string;
};
export type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: { name: string; status: string; title: string; output: string }[];
};
export type Approval = {
  id: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
};
export type Question = {
  id: string;
  questions: {
    header: string;
    question: string;
    multiple?: boolean;
    options: { label: string; description: string }[];
  }[];
};
export type Task = {
  id: string;
  number: number;
  projectID: string;
  title: string;
  description: string;
  criteria: string;
  creatorID: string;
  assigneeID: string;
  approverID: string;
  reviewerID: string;
  acceptedBy: string | null;
  state: TaskState;
  version: number;
  createdAt: string;
  updatedAt: string;
  model: string;
  sessionID: string | null;
  baseCommit: string | null;
  runAfter: number;
  messages: Message[];
  approvals: Approval[];
  questions: Question[];
  artifacts: Artifact[];
  artifactHash: string | null;
  diffSource: string;
  error: string | null;
};
export type Bootstrap = {
  user: User;
  users: User[];
  projects: Project[];
  tasks: Task[];
  engine: {
    ready: boolean;
    version: string;
    models: { id: string; name: string }[];
    error: string | null;
  };
  defaultModel: string;
  network: NodeNetwork;
};
export type BrainSummary = {
  id: string;
  name: string;
};
export type RivloomNode = {
  id: string;
  name: string;
  fingerprint: string;
  protocolVersion: number;
  addresses: string[];
  port: number;
  online: boolean;
  local: boolean;
  trusted: boolean;
  verified: boolean;
  lastSeen: string;
  capabilities: string[];
  brains: BrainSummary[];
};
export type NodeNetwork = {
  status: 'starting' | 'online' | 'degraded' | 'disabled';
  serviceType: string;
  local: RivloomNode | null;
  nearby: RivloomNode[];
  error: string | null;
};
export type ModelCheck = {
  status: 'testing' | 'passed' | 'failed' | 'interrupted';
  at: string;
  message: string;
};
export type ModelOperation = {
  id: number;
  actorID: string | null;
  actorName: string;
  kind:
    | 'credential_saved'
    | 'credential_removed'
    | 'default_changed'
    | 'test_started'
    | 'test_finished';
  provider: string;
  model: string | null;
  result: string;
  at: string;
};
export type ModelSettings = {
  defaultModel: string;
  models: { id: string; name: string }[];
  deepseekConfigured: boolean;
  credentialUpdatedAt: string | null;
  credentialState: 'unconfigured' | 'configured_unverified' | 'verified' | 'needs_review';
  checks: Record<string, ModelCheck>;
  busy: boolean;
  busyReason: string | null;
  operations: ModelOperation[];
};
export const stateLabels: Record<TaskState, string> = {
  open: '待接受',
  ready: '待执行',
  running: '执行中',
  waiting_approval: '待审批',
  waiting_input: '待补充',
  stopping: '正在停止',
  stopped: '已停止',
  interrupted: '执行中断',
  failed: '执行失败',
  review: '待验收',
  accepted: '已验收',
};
export const activeStates: TaskState[] = [
  'running',
  'waiting_approval',
  'waiting_input',
  'stopping',
];
