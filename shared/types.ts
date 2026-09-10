import { t } from './i18n.ts';
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
export type ApprovalMode = 'ask' | 'auto' | 'full';
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
export type RemoteTaskControlAction =
  | { kind: 'permission'; requestID: string; reply: 'once' | 'reject' }
  | { kind: 'question'; requestID: string; answers: string[][] }
  | { kind: 'stop' }
  | { kind: 'supplement'; text: string }
  | { kind: 'accept'; note: string };
export type Task = {
  collaboration?: import('./workflows.ts').WorkflowExecutionContext;
  collaborationOutcome?: {
    sessionID: string;
    attempt: number;
    runAfter: number;
    quiescence: { confirmed: boolean; reason: string };
    value: import('./workflows.ts').PlanningOutcome | import('./workflows.ts').ExecutionOutcome;
  };
  inputFiles?: import('./task-files.ts').TaskFileDescriptor[];
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
  approvalMode: ApprovalMode;
  sessionID: string | null;
  runAfter: number;
  messages: Message[];
  approvals: Approval[];
  questions: Question[];
  artifacts: Artifact[];
  diffSource: string;
  error: string | null;
  remoteOrigin?: {
    remoteTaskID: string;
    ownerNodeID: string;
    ownerBrainID: string;
  };
};
export type Bootstrap = {
  resourceDirectory?: import('./resources.ts').ResourceDiscoveryNode[];
  workflows?: import('./workflows.ts').Workflow[];
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
  executionPolicy: NodeExecutionPolicy;
  network: NodeNetwork;
};
export type BrainSummary = {
  id: string;
  name: string;
  masterNodeID: string;
  state: 'provisional' | 'established';
  queueDepth?: number;
};
export type WorkerProject = {
  id: string;
  name: string;
};
export type WorkerHardware = {
  platform: string;
  release: string;
  architecture: string;
  cpuModel: string;
  physicalCores: number | null;
  logicalCores: number;
  memoryBytes: number;
  gpus: { name: string; memoryBytes: number | null }[];
  diskBytes: number | null;
  collectedAt: string;
};
export type WorkerLoad = {
  cpuPercent: number | null;
  memoryAvailableBytes: number;
  memoryUsedPercent: number;
  gpuPercent: number | null;
  gpuMemoryAvailableBytes: number | null;
  diskAvailableBytes: number | null;
  runningTasks: number;
  availableSlots: number;
  sampledAt: string;
};
export type WorkerRegistration = {
  nodeID: string;
  accepting: boolean;
  projects: WorkerProject[];
  hardware: WorkerHardware;
  load: WorkerLoad;
};
export type TaskHardwareRequirements = {
  platform?: string;
  architecture?: string;
  minimumLogicalCores?: number;
  minimumMemoryBytes?: number;
  gpu?: boolean;
  minimumGpuMemoryBytes?: number;
};
export type TaskPlacementRequirements = {
  projectID: string | null;
  requirements: TaskHardwareRequirements;
};
export type BrainTaskExecution = {
  attempt: number;
  executionID: string;
  workerNodeID: string;
  status: 'assigned' | 'running' | 'waiting' | 'review' | 'completed' | 'failed';
  sequence: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
};
export type BrainTask = {
  inputFiles?: import('./task-files.ts').TaskFileDescriptor[];
  queueReceipt?: import('./task-queue-receipts.ts').TaskQueueReceipt | null;
  id: string;
  direction: 'submitted' | 'owned';
  submitterNodeID: string;
  brainID: string;
  masterNodeID: string;
  title: string;
  description: string;
  criteria: string;
  requestedProjectID: string | null;
  requirements: TaskHardwareRequirements;
  status:
    | 'submitting'
    | 'queued'
    | 'assigned'
    | 'running'
    | 'waiting'
    | 'review'
    | 'completed'
    | 'failed';
  selectedWorkerID: string | null;
  executionID: string | null;
  executionSequence: number;
  executionSummary: string;
  executionAttempt: number;
  executions: BrainTaskExecution[];
  retryNotBefore: string | null;
  deliveryPending: boolean;
  deliveryError: string | null;
  createdAt: string;
  updatedAt: string;
};
export type RemoteTaskInvite = {
  inputFiles?: import('./task-files.ts').TaskFileDescriptor[];
  queueReceipt?: import('./task-queue-receipts.ts').TaskQueueReceipt | null;
  /** Local observation of authenticated offer delivery; never inferred from API creation. */
  deliveredAt?: string | null;
  transmissionState?: 'saved' | 'sending' | 'delivered' | 'transmission_unknown';
  id: string;
  brainTaskID: string | null;
  direction: 'incoming' | 'outgoing';
  ownerNodeID: string;
  ownerBrainID: string;
  targetNodeID: string;
  targetBrainID: string;
  title: string;
  description: string;
  criteria: string;
  requestedProjectID: string | null;
  requirements: TaskHardwareRequirements;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  automaticEligible: boolean;
  executionStatus: 'unprepared' | 'ready' | 'revoked' | 'expired';
  executionLeaseID: string | null;
  executionLeaseExpiresAt: string | null;
  executionUpdatedAt: string | null;
  localProjectID: string | null;
  localModel: string | null;
  localTaskID: string | null;
  executionState: 'not_started' | TaskState;
  executionSequence: number;
  executionSummary: string;
  remoteApprovals: Approval[];
  remoteQuestions: Question[];
  remoteArtifacts: Artifact[];
  remoteDiffSource: string;
  controlPending: boolean;
  deliveryPending: boolean;
  deliveryError: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};
export type NodeExecutionPolicy = {
  enabled: boolean;
  approvalMode: ApprovalMode;
  projectID: string | null;
  model: string | null;
  /** Concurrent executions received from other Nodes. Locally originated work has no fixed limit. */
  maxConcurrent: number;
  updatedAt: string | null;
};
export type RivloomNode = {
  /** Actual local observation of a verified message. Null after restart until observed again. */
  lastContactAt?: string | null;
  nodeQueue?: import('./task-queue-receipts.ts').NodeQueuePublicStats | null;
  id: string;
  name: string;
  icon?: string;
  /** Private metadata from this installation; never sent to the peer. */
  remark?: string;
  lastUsedAt?: string;
  fingerprint: string;
  protocolVersion: number;
  addresses: string[];
  port: number;
  online: boolean;
  local: boolean;
  trusted: boolean;
  channelReady: boolean;
  verified: boolean;
  lastSeen: string;
  capabilities: string[];
  brains: BrainSummary[];
  worker: WorkerRegistration | null;
};
export type BrainTopology = BrainSummary & {
  hosted: boolean;
  online: boolean;
  queueDepth: number;
  workers: WorkerRegistration[];
};
export type NodeNetwork = {
  diagnostics?: {
    mdnsActive: boolean;
    udpActive: boolean;
    lastRetryAt: string | null;
    incompatibleAnnouncementAt: string | null;
  };
  status: 'starting' | 'online' | 'degraded' | 'disabled';
  serviceType: string;
  local: RivloomNode | null;
  nearby: RivloomNode[];
  paired?: RivloomNode[];
  brains: BrainTopology[];
  pairings: NodePairing[];
  remoteTasks: RemoteTaskInvite[];
  brainTasks: BrainTask[];
  error: string | null;
};
export type NodePairing = {
  id: string;
  nodeID: string;
  direction: 'incoming' | 'outgoing';
  code: string;
  expiresAt: string;
  localConfirmed: boolean;
  remoteConfirmed: boolean;
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
  get open() {
    return t('待接受');
  },
  get ready() {
    return t('待执行');
  },
  get running() {
    return t('执行中');
  },
  get waiting_approval() {
    return t('待审批');
  },
  get waiting_input() {
    return t('待补充');
  },
  get stopping() {
    return t('正在停止');
  },
  get stopped() {
    return t('已停止');
  },
  get interrupted() {
    return t('执行中断');
  },
  get failed() {
    return t('执行失败');
  },
  get review() {
    return t('已完成');
  },
  get accepted() {
    return t('已完成');
  },
};
export const approvalModeLabels: Record<ApprovalMode, string> = {
  get ask() {
    return t('请求批准');
  },
  get auto() {
    return t('帮我批准');
  },
  get full() {
    return t('允许任何操作');
  },
};
export const activeStates: TaskState[] = [
  'running',
  'waiting_approval',
  'waiting_input',
  'stopping',
];
