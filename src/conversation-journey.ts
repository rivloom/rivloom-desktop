import type { Conversation } from '../shared/conversations.ts';
import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
import type { ActivityTransfer } from './conversation-activity.ts';
import type { TaskFileQuery } from './task-file-state.ts';

export type JourneyState = 'active' | 'waiting' | 'complete' | 'failed' | 'unknown' | 'stopped';
export type JourneyCounts = Record<JourneyState, number>;
export type JourneyDevice = { id: string; local: boolean; executing: boolean };
export type JourneyTransferGroup = {
  key: string; route: TaskFileQuery; peerNodeID: string | null;
  fromNodeID: string | null; toNodeID: string | null; direction: ActivityTransfer['direction'];
  fileCount: number; bytes: number; total: number; state: JourneyState; counts: JourneyCounts;
  transferKeys: string[]; fresh: boolean;
};
export type JourneyConnection = Omit<JourneyTransferGroup, 'route' | 'peerNodeID'> & { groupKeys: string[] };
export type JourneyStage = {
  key: string; kind: 'execution' | 'transfer' | 'handoff'; state: JourneyState;
  nodeID: string | null; fromNodeID: string | null; toNodeID: string | null;
  title: string; groupKey: string | null; stepID: string | null; attempt: number | null;
  /** Only explicit dependencies, never the order of this array. */
  dependsOn: string[]; historical: boolean;
};
export type ConversationJourney = {
  key: string; identityIndex: number; devices: JourneyDevice[];
  groups: JourneyTransferGroup[]; connections: JourneyConnection[]; stages: JourneyStage[];
  completed: boolean; canSettle: boolean; fresh: boolean; historical: boolean;
  /** Omitted unless every recorded handoff has complete, verifiable endpoint evidence. */
  handoffCount?: number;
};
export type ConversationJourneyInput = {
  conversationKey: string; localNodeID: string | null; transfers: readonly ActivityTransfer[];
  workflow?: Workflow; conversation?: Conversation; fresh?: boolean; historical?: boolean;
  /** Explicit user retrievals may belong to an older attempt, but never another conversation. */
  requestedRoutes?: readonly TaskFileQuery[];
};

const identity = (value: string | null | undefined) => value || null;
const routeKey = (route: TaskFileQuery) => JSON.stringify([route.scope, route.taskID]);
const emptyCounts = (): JourneyCounts => ({ active: 0, waiting: 0, complete: 0, failed: 0, unknown: 0, stopped: 0 });
const combineState = (counts: JourneyCounts): JourneyState =>
  counts.failed ? 'failed' : counts.unknown ? 'unknown' : counts.active ? 'active'
    : counts.waiting ? 'waiting' : counts.stopped ? 'stopped' : counts.complete ? 'complete' : 'unknown';
const executionKey = (attempt: WorkflowAttempt) => JSON.stringify(['execution', attempt.kind, attempt.executionID, attempt.number]);

/** Stable conversation identity, independent of theme, retry, title and collection order. */
export function conversationIdentityIndex(conversationKey: string): number {
  let value = 2166136261;
  for (let i = 0; i < conversationKey.length; i++) value = Math.imul(value ^ conversationKey.charCodeAt(i), 16777619);
  return (value >>> 0) % 6;
}

function executionState(state: string | null | undefined): JourneyState {
  if (state === 'running') return 'active';
  if (['completed', 'review', 'accepted'].includes(state || '')) return 'complete';
  if (state === 'failed') return 'failed';
  if (['stopped', 'cancelled', 'declined', 'rejected', 'expired'].includes(state || '')) return 'stopped';
  if (['unknown', 'interrupted'].includes(state || '') || !state) return 'unknown';
  return 'waiting';
}

function transferState(file: ActivityTransfer, fresh: boolean): JourneyState {
  if (!fresh) return 'unknown';
  if (file.state === 'complete') return file.bytes === file.total ? 'complete' : 'unknown';
  if (file.state === 'failed') return 'failed';
  return file.state === 'waiting' ? 'waiting' : 'active';
}

/** Keep ownership separate even when several execution routes share one visual wire. */
export function journeyTransferGroups(files: readonly ActivityTransfer[], localNodeID: string | null,
  options: { fresh?: boolean; historical?: boolean } = {}): JourneyTransferGroup[] {
  const groups = new Map<string, JourneyTransferGroup>();
  const unique = new Map(files.map(file => [file.key, file]));
  for (const file of unique.values()) {
    const peer = identity(file.peerNodeID), local = identity(localNodeID);
    const key = JSON.stringify([file.route.scope, file.route.taskID, peer, file.direction]);
    const fresh = options.fresh !== false && file.fresh && !options.historical;
    // Historical receipts retain their recorded result but never become live movement.
    const state = transferState(file, options.historical ? file.fresh : fresh);
    let group = groups.get(key);
    if (!group) {
      group = { key, route: { ...file.route }, peerNodeID: peer,
        fromNodeID: file.direction === 'send' ? local : peer, toNodeID: file.direction === 'send' ? peer : local,
        direction: file.direction, fileCount: 0, bytes: 0, total: 0, counts: emptyCounts(),
        state: 'unknown', transferKeys: [], fresh };
      groups.set(key, group);
    }
    group.fileCount++;
    group.bytes += Math.max(0, Math.min(file.bytes, file.total));
    group.total += Math.max(0, file.total);
    group.counts[state]++;
    group.transferKeys.push(file.key);
    group.fresh &&= fresh;
    group.state = combineState(group.counts);
  }
  return [...groups.values()];
}

/** A visual connection may combine routes, while its keys retain all original owners. */
export function journeyConnections(groups: readonly JourneyTransferGroup[]): JourneyConnection[] {
  const result = new Map<string, JourneyConnection>();
  for (const group of groups) {
    if (!group.fromNodeID || !group.toNodeID || group.fromNodeID === group.toNodeID) continue;
    const key = JSON.stringify([group.fromNodeID, group.toNodeID, group.direction]);
    let connection = result.get(key);
    if (!connection) {
      connection = { key, fromNodeID: group.fromNodeID, toNodeID: group.toNodeID, direction: group.direction,
        groupKeys: [], transferKeys: [], fileCount: 0, bytes: 0, total: 0, state: 'unknown',
        counts: emptyCounts(), fresh: true };
      result.set(key, connection);
    }
    connection.groupKeys.push(group.key);
    connection.transferKeys.push(...group.transferKeys);
    connection.fileCount += group.fileCount;
    connection.bytes += group.bytes; connection.total += group.total;
    for (const state of Object.keys(connection.counts) as JourneyState[]) connection.counts[state] += group.counts[state];
    connection.fresh &&= group.fresh;
    connection.state = combineState(connection.counts);
  }
  return [...result.values()];
}

/** Current-round presentation only: neither old attempts nor remote manifests invent a return trip. */
export function conversationJourney(input: ConversationJourneyInput): ConversationJourney {
  const workflow = input.workflow || input.conversation?.workflow;
  const historical = input.historical === true, observed = input.fresh !== false;
  const local = identity(input.localNodeID), stages: JourneyStage[] = [], allowedRoutes = new Set<string>();
  let completed = false, terminalEvidence = true, identityPart = '', handoffCount: number | undefined;
  const addRoute = (scope: TaskFileQuery['scope'], taskID: string) => allowedRoutes.add(routeKey({ scope, taskID }));
  const observedState = (state: JourneyState) => !observed && !historical ? 'unknown' : state;
  if (workflow) {
    const steps = workflow.planVersion ? [workflow.planner, ...workflow.steps] : [workflow.planner];
    const current = new Map<string, { step: WorkflowStep; attempt: WorkflowAttempt }>();
    for (const step of steps) {
      const attempt = step.attempts.at(-1);
      if (attempt) { current.set(step.id, { step, attempt }); addRoute(attempt.kind, attempt.executionID); }
    }
    const ownedSteps = [...(workflow.rounds || []).flatMap(round => [round.planner, ...round.steps]), ...steps];
    const ownedRoutes = new Set(ownedSteps.flatMap(step => step.attempts.map(attempt =>
      routeKey({ scope: attempt.kind, taskID: attempt.executionID }))));
    if (!historical) for (const route of input.requestedRoutes || []) {
      if (ownedRoutes.has(routeKey(route))) allowedRoutes.add(routeKey(route));
    }
    identityPart = JSON.stringify([workflow.roundRequestID || workflow.requestID,
      [...current.values()].map(({ attempt }) => [attempt.executionID, attempt.number]).sort()]);
    for (const step of steps) {
      const attempt = current.get(step.id)?.attempt;
      const state = observedState(attempt ? executionState(attempt.phase) : executionState(step.state));
      const nodeID = identity(attempt?.nodeID), fromNodeID = identity(workflow.originNodeID);
      stages.push({ key: attempt ? executionKey(attempt) : JSON.stringify(['step', step.id]),
        kind: 'execution', state, nodeID, fromNodeID, toNodeID: nodeID, title: step.title,
        stepID: step.id, attempt: attempt?.number || null, groupKey: null, historical,
        dependsOn: step.dependsOn.flatMap(id => {
          const dependency = current.get(id)?.attempt;
          return dependency ? [executionKey(dependency)] : [];
        }) });
      if (step.state !== 'completed' || !attempt || attempt.phase !== 'completed') terminalEvidence = false;
    }
    const handoffs = new Map(workflow.handoffs.map(handoff => [handoff.id, handoff]));
    let verifiedHandoffs = 0;
    for (const handoff of handoffs.values()) {
      const step = steps.find(item => item.id === handoff.stepID);
      const from = step?.attempts.find(attempt => attempt.number === handoff.fromAttempt);
      const to = step?.attempts.find(attempt => attempt.number === handoff.toAttempt);
      const bound = !!from && !!to && from.nodeID === handoff.fromNodeID && to.nodeID === handoff.toNodeID
        && from.executionID !== to.executionID && !!handoff.fromNodeID && !!handoff.toNodeID
        && handoff.fromNodeID !== handoff.toNodeID;
      const latest = step?.attempts.at(-1);
      const superseded = bound && !!latest && latest.number > handoff.toAttempt
        && latest.phase === 'completed' && step?.state === 'completed';
      if (bound && handoff.phase === 'completed') verifiedHandoffs++;
      const state = observedState(!bound ? 'unknown' : handoff.phase === 'completed' ? 'complete'
        : handoff.phase === 'blocked' ? 'failed' : 'waiting');
      stages.push({ key: JSON.stringify(['handoff', handoff.id]), kind: 'handoff', state,
        nodeID: null, fromNodeID: bound ? handoff.fromNodeID : null, toNodeID: bound ? handoff.toNodeID : null,
        title: step?.title || '', stepID: handoff.stepID, attempt: handoff.toAttempt, groupKey: null,
        dependsOn: [], historical: historical || handoff.phase === 'completed' || superseded });
      if (state !== 'complete' && !superseded) terminalEvidence = false;
    }
    if (handoffs.size && verifiedHandoffs === handoffs.size) handoffCount = verifiedHandoffs;
    completed = workflow.state === 'completed';
    // The following-round queue has its own visible controls outside this current-round journey.
    terminalEvidence &&= !workflow.pendingConfirmation && !workflow.error;
  } else if (input.conversation) {
    const item = input.conversation, brain = item.brainTask, remote = item.remote, task = item.localTask;
    if (brain) addRoute('brain', brain.id);
    if (remote) addRoute('remote', remote.id);
    if (task) addRoute('local', task.id);
    const brainExecution = brain?.executions.find(entry => entry.executionID === brain.executionID);
    const executionID = brain?.executionID || remote?.id || task?.id || '';
    const attempt = brainExecution?.attempt || (brain?.executionAttempt || null);
    identityPart = JSON.stringify([executionID, attempt, task?.sessionID || null, task?.runAfter || 0]);
    // A selected/preferred device is not evidence that execution actually started there.
    const nodeID = task ? local : remote ? identity(remote.targetNodeID)
      : brainExecution ? identity(brainExecution.workerNodeID) : null;
    const fromNodeID = identity(brain?.submitterNodeID || remote?.ownerNodeID || task?.remoteOrigin?.ownerNodeID
      || (!item.incoming && task ? local : item.sourceNodeID));
    const rawState = task?.state || (remote && !['pending', 'accepted'].includes(remote.status) ? remote.status
      : remote?.executionState !== 'not_started' ? remote?.executionState : undefined)
      || brainExecution?.status || brain?.status || remote?.executionState;
    let state = observedState(executionState(rawState));
    if (!task && !remote && !brainExecution && state === 'active') state = 'unknown';
    stages.push({ key: JSON.stringify(['execution', executionID, attempt]), kind: 'execution', state,
      nodeID, fromNodeID, toNodeID: nodeID, title: item.title, stepID: null, attempt, groupKey: null,
      dependsOn: [], historical });
    completed = executionState(rawState) === 'complete';
    terminalEvidence = state === 'complete' && !task?.approvals.length && !task?.questions.length
      && !remote?.remoteApprovals.length && !remote?.remoteQuestions.length && !remote?.controlPending
      && !remote?.deliveryPending && !remote?.deliveryError && !brain?.deliveryPending && !brain?.deliveryError;
    if (brain) {
      const unfinished = brain.executions.some(entry => entry.executionID !== brain.executionID
        && ['assigned', 'running', 'waiting'].includes(entry.status));
      terminalEvidence &&= !unfinished && ['review', 'completed'].includes(brain.status);
    }
  } else {
    terminalEvidence = false;
  }
  const transfers = input.transfers.filter(file => allowedRoutes.has(routeKey(file.route)));
  const groups = journeyTransferGroups(transfers, local, { fresh: observed, historical });
  for (const group of groups) stages.push({ key: JSON.stringify(['transfer', group.key]), kind: 'transfer',
    state: group.state, nodeID: null, fromNodeID: group.fromNodeID, toNodeID: group.toNodeID,
    title: '', stepID: null, attempt: null, groupKey: group.key, dependsOn: [], historical });
  const devices = new Map<string, JourneyDevice>();
  const addDevice = (id: string | null, executing = false) => {
    if (!id) return;
    const existing = devices.get(id);
    devices.set(id, { id, local: id === local, executing: executing || !!existing?.executing });
  };
  addDevice(local);
  for (const stage of stages) {
    addDevice(stage.fromNodeID); addDevice(stage.toNodeID);
    addDevice(stage.nodeID, stage.kind === 'execution' && stage.state === 'active' && observed && !historical);
  }
  const fresh = observed && !historical && groups.every(group => group.fresh);
  return { key: JSON.stringify([input.conversationKey, identityPart]), identityIndex: conversationIdentityIndex(input.conversationKey),
    devices: [...devices.values()], groups, connections: journeyConnections(groups), stages,
    completed, canSettle: completed && terminalEvidence && fresh && groups.every(group => group.state === 'complete'),
    fresh, historical, ...(handoffCount !== undefined ? { handoffCount } : {}) };
}
