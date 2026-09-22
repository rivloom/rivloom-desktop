import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditServiceMatrix } from './ci-services.ts';

// File membership is explicit: adding a test file requires assigning its CI lane.
export const logicFiles = [
  'tests/workflow-knowledge.test.ts',
  'tests/runtime-history.test.ts',
  'tests/workflow-history.test.ts',
  'tests/task-context.test.ts',
  'tests/task-stream.test.ts',
  'tests/windows-engine-stop.test.ts',
  'tests/engine-artifact.test.ts',
  'tests/workflow-activity.test.ts',
  'tests/workflow-message-edits.test.ts',
  'tests/composer-keyboard.test.ts',
  'tests/conversation-draft-indicators.test.ts',
  'tests/conversation-export.test.ts',
  'tests/message-reuse.test.ts',
  'tests/project-changes.test.ts',
  'tests/prompt-templates.test.ts',
  'tests/task-telemetry.test.ts',
  'tests/task-telemetry-engine.test.ts',
  'tests/workspace-commands.test.ts',
  'tests/current-conversation-find.test.ts',
  'tests/headless-runtime.test.ts',
  'tests/headless-cli.test.ts',
  'tests/lan-firewall.test.ts',
  'tests/workflow-diagnostics.test.ts',
  'tests/knowledge.test.ts',
  'tests/knowledge-network.test.ts',
  'tests/knowledge-tools.test.ts',
  'tests/model-providers.test.ts',
  'tests/conversation-search.test.ts',
  'tests/file-preview.test.ts',
  'tests/conversation-history.test.ts',
  'tests/desktop-update.test.ts',
  'tests/execution-policy.test.ts',
  'tests/worker-admission.test.ts',
  'tests/engine-permissions.test.ts',
  'tests/workflow-ui.test.ts',
  'tests/workflow-service.test.ts',
  'tests/workflow-planning.test.ts',
  'tests/workflow-contexts.test.ts',
  'tests/workflow-files.test.ts',
  'tests/resource-capabilities.test.ts',
  'tests/collaboration-channel.test.ts',
  'tests/resources.test.ts',
  'tests/workflows.test.ts',
  'tests/resource-catalog.test.ts',
  'tests/resource-network.test.ts',
  'tests/i18n.test.ts',
  'tests/security.test.ts',
  'tests/remote-task-clock.test.ts',
  'tests/http-ports.test.ts',
  'tests/physical-resume.test.ts',
  'tests/physical-race.test.ts',
  'tests/conversations.test.ts',
  'tests/conversation-filters.test.ts',
  'tests/sidebar-layout.test.ts',
  'tests/app-version.test.ts',
  'tests/task-attention.test.ts',
  'tests/node-diagnostics.test.ts',
  'tests/task-files.test.ts',
  'tests/task-file-flow.test.ts',
  'tests/node-profile.test.ts',
  'tests/node-mentions.test.ts',
  'tests/machine-status.test.ts',
  'tests/conversation-drafts.test.ts',
  'tests/directed-node-tasks.test.ts',
  'tests/node-queue.test.ts',
  'tests/node-queue-recovery.test.ts',
  'tests/node-queue-controls.test.ts',
  'tests/node-health.test.ts',
  'tests/task-queue-receipts.test.ts',
  'tests/task-receipts.test.ts',
  'tests/task-completion.test.ts',
  'tests/api.test.ts',
  'tests/desktop-refresh.test.ts',
  'tests/task-queries.test.ts',
  'tests/worker-resources.test.ts',
  'tests/release-record.test.ts',
  'tests/ci-runtime.test.ts',
] as const;
export const engineFiles = ['tests/engine-ports.test.ts', 'tests/provider-oauth-engine.test.ts'] as const;
export const networkFile = 'tests/node-network.test.ts';

// Exact names, not broad exclusions: the audit fails on unclassified/new/renamed tests.
// The existing source file and every assertion remain unchanged.
export const networkCases = {
  logic: [
    'node rate limits isolate discovery, hello and channel budgets without bypassing caps',
    'node response limits distinguish encrypted collaboration data from small control replies',
    'GPU memory parsing preserves values above 4 GiB and treats unavailable values as unknown',
    'worker resource validation excludes identity and secret-shaped hardware fields',
    'worker scheduling filters stale and incompatible reports before ranking live capacity',
    'worker scheduling uses stable node IDs to break equal load scores',
    'node final admission serializes competing Brains before reserving one global slot',
    'brain task placement chooses an established online Brain and its lowest-load Worker',
    'brain task placement excludes each Brain Master even when the Brain is remote',
    'brain task placement waiting reason persists and syncs without fabricating Execution progress',
    'brain topology migrates a legacy node Brain as established and stable',
    'brain task submission gives the Master an authoritative Task and a separate Execution ID',
    'brain task retries a safely rejected Execution and fences delayed results from the old ID',
    'brain task store migrates version 1 records into explicit Execution history',
    'automatic brain formation adopts established masters and never merges established Brains',
    'authenticated Master withdrawal removes only its provisional registration',
    'automatic brain formation deterministically keeps the lower provisional master',
    'queue receipt authenticated ACK binds the exact request without consuming stream sequence',
    'node network only accepts local and private source addresses',
    'remote task invitations persist and apply idempotent offer and response messages',
    'execution policy trusts paired senders and persists the local AI approval mode',
  ],
  protocol: [
    'collaboration extensions serialize authenticated queries without creating task executions',
    'brain task placement rejects remote Master-only capacity and resumes the original queue on a third Worker',
    'shared workers register with two Brains and a declined Execution is reassigned safely',
    'offline pending Execution retries, late acceptance is fenced, accepted unknown waits',
    'queue receipt network does not treat an unauthenticated success response as delivery',
    'queue receipt network preserves fresh authenticated statistics across signed hello refresh',
    'workload statistics negotiate with the real previous queue-v1 decoder',
    'queue receipt network keeps legacy capability peers usable without sending new queue fields',
    'queue receipt network fences wrong routes and reordering and replays after lost ACK and reconnect',
    'node identity is stable and the private key is protected with Windows DPAPI',
    'node trust storage rejects conflicting trusted and revoked records',
    'secure node channel derives directional keys and rejects tamper, replay and expiry',
    'two nodes require bilateral confirmation, persist trust, reject replay and revoke both sides',
  ],
  mdns: ['two isolated Rivloom instances discover and cryptographically verify each other'],
  udp: ['UDP broadcast fallback discovers and verifies two nodes without mDNS'],
} as const;

export type TestLane = keyof typeof networkCases | 'engine';
export const testLanes: readonly TestLane[] = ['logic', 'protocol', 'engine', 'mdns', 'udp'];

export function exactPattern(names: readonly string[]) {
  assert(names.length > 0, 'An exact test selection cannot be empty');
  return new RegExp(
    `^(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
  );
}

export function auditNetworkCases(source: string, groups: Record<string, readonly string[]>) {
  // The shared network file currently uses top-level test('literal', ...) calls.
  // Fail closed if that declaration format changes; do not guess at dynamic names.
  const declarations = [...source.matchAll(/^[ \t]*test(?:\.[A-Za-z]+)?\s*\(/gm)];
  const names = [...source.matchAll(/^[ \t]*test\(\s*'([^'\r\n\\]+)'\s*,/gm)].map(
    (match) => match[1]!,
  );
  assert.equal(
    names.length,
    declarations.length,
    'Network test declarations require an explicit audit',
  );
  assert.equal(new Set(names).size, names.length, 'Duplicate network test name');
  const assigned = Object.values(groups).flat();
  assert.equal(new Set(assigned).size, assigned.length, 'Network test assigned to multiple lanes');
  assert.deepEqual(
    [...assigned].sort(),
    [...names].sort(),
    'Network test mapping is incomplete or stale',
  );
  return names.length;
}

export function auditCoverage(root = resolve('.')) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const command = String(manifest.scripts.test).trim().split(/\s+/);
  assert.deepEqual(command.slice(0, 2), ['node', '--test'], 'Keep the npm test full-suite entry');
  const fullFiles = command.slice(2);
  const mappedFiles = [...logicFiles, ...engineFiles, networkFile];
  const discoveredFiles = readdirSync(resolve(root, 'tests'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => `tests/${file.replaceAll('\\', '/')}`);
  for (const [label, values] of [
    ['full entry', fullFiles],
    ['lane mapping', mappedFiles],
  ] as const) {
    assert.equal(new Set(values).size, values.length, `Duplicate file in ${label}`);
    assert.deepEqual(
      [...values].sort(),
      [...discoveredFiles].sort(),
      `${label} must cover every tests/*.test.ts file`,
    );
  }
  const networkCount = auditNetworkCases(
    readFileSync(resolve(root, networkFile), 'utf8'),
    networkCases,
  );
  const serviceChecks = auditServiceMatrix(
    readFileSync(resolve(root, '.github/workflows/windows-services.yml'), 'utf8'),
  );
  return {
    fullFiles,
    logicFiles,
    engineFiles,
    networkFile,
    networkCases,
    networkCount,
    serviceChecks,
  };
}
