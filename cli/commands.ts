import { validReasoningEffort } from '../shared/model-reasoning.ts';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Bootstrap, NodeExecutionPolicy, NodeNetwork } from '../shared/types.ts';
import type { NodeQueueSnapshot } from '../shared/node-queue.ts';
import { validNodeProfile } from '../shared/node-profile.ts';
import { validRemoteConcurrency } from '../shared/execution-concurrency.ts';

export const help = `Rivloom Linux execution node

Usage: rivloom [--lang en|zh-CN] [--data-dir PATH] COMMAND [OPTIONS] [--json]

  init [--name NAME]                    Initialize private local data
  serve [--peer-port PORT]              Run the node until SIGINT/SIGTERM
  name NAME                            Rename this running node
  status                               Node, engine, execution and queue status
  nodes                                Nearby/trusted nodes and pairing codes
  pair list | request NODE_ID          Inspect or start a pairing
  pair confirm PAIRING_ID --code CODE  Confirm only after comparing both codes
  pair cancel PAIRING_ID               Cancel a pairing
  pair revoke NODE_ID --confirm        Revoke trust
  projects list                       List authorized local projects
  projects add PATH --name NAME --confirm
  providers list                      List available providers
  providers key PROVIDER --stdin --confirm [--account NAME] [--account-id ID]
  providers custom --stdin --confirm  Read {provider, key?} JSON from stdin
  providers remove PROVIDER --confirm
  models list | default MODEL         List models or select the default
  execution status | disable
  execution enable --project ID --model MODEL --approval ask|auto|full [--thinking auto|LEVEL] --confirm
  execution concurrency NUMBER        Set 1–10 concurrent remote executions
  queue list | pause | resume
  pending                             List permission requests and questions
  approve TASK_ID REQUEST_ID once|reject
  respond TASK_ID REQUEST_ID --stdin   Read an array of answer arrays as JSON
  service [--executable PATH] [--peer-port PORT]
                                      Print a systemd user unit; do not install
  --version                            Print the application version

Most commands need a running 'rivloom serve'. Results are JSON by default.
API keys and custom-provider JSON are accepted only through stdin.
Execution starts disabled. 'ask' waits for individual approval when required.
Thinking defaults to auto (model/runtime defaults); list supported levels with models list.
Thinking defaults to auto (model/runtime defaults); list supported levels with models list.
Use --lang en or --lang zh-CN; otherwise follow LC_ALL, LC_MESSAGES or LANG.
`;

type CommandSpec = { count: number; options?: string[]; switches?: string[] };
const specs: Record<string, CommandSpec> = {
  init: { count: 0, options: ['name'] }, serve: { count: 0, options: ['peer-port'] }, name: { count: 1 },
  status: { count: 0 }, nodes: { count: 0 }, 'pair list': { count: 0 },
  'pair request': { count: 1 }, 'pair confirm': { count: 1, options: ['code'] },
  'pair cancel': { count: 1 }, 'pair revoke': { count: 1, switches: ['confirm'] },
  'projects list': { count: 0 }, 'projects add': { count: 1, options: ['name'], switches: ['confirm'] },
  'providers list': { count: 0 },
  'providers key': { count: 1, options: ['account', 'account-id'], switches: ['stdin', 'confirm'] },
  'providers custom': { count: 0, switches: ['stdin', 'confirm'] },
  'providers remove': { count: 1, switches: ['confirm'] },
  'models list': { count: 0 }, 'models default': { count: 1 },
  'execution status': { count: 0 }, 'execution disable': { count: 0 },
  'execution enable': { count: 0, options: ['project', 'model', 'approval', 'thinking'], switches: ['confirm'] },
  'execution concurrency': { count: 1 },
  'queue list': { count: 0 }, 'queue pause': { count: 0 }, 'queue resume': { count: 0 },
  pending: { count: 0 }, approve: { count: 3 }, respond: { count: 2, switches: ['stdin'] },
  service: { count: 0, options: ['executable', 'peer-port'] },
};
const valueOptions = new Set(['data-dir', 'name', 'code', 'account', 'account-id', 'project', 'model', 'approval', 'thinking', 'executable', 'peer-port']);
const switchOptions = new Set(['json', 'confirm', 'stdin', 'help', 'version']);
const groups = new Set(['pair', 'projects', 'providers', 'models', 'execution', 'queue']);
export type Command = { name: string; args: string[]; options: Record<string, string | true> };

export function parseArguments(argv: readonly string[]): Command {
  const options: Command['options'] = {}, words: string[] = [];
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === '--' && !literal) { literal = true; continue; }
    if (!literal && (word === '-h' || word.startsWith('--'))) {
      const key = word === '-h' ? 'help' : word.slice(2);
      if (Object.hasOwn(options, key)) throw new Error(`Duplicate option --${key}`);
      if (switchOptions.has(key)) options[key] = true;
      else if (valueOptions.has(key)) {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`Option --${key} needs a value`);
        options[key] = value;
      } else throw new Error('Unknown option. Run rivloom --help.');
    } else words.push(word);
  }
  if (options.version) {
    if (words.length || Object.keys(options).some(key => !['version', 'json'].includes(key))) throw new Error('--version cannot be combined with a command.');
    return { name: 'version', args: [], options };
  }
  if (options.help || !words.length) return { name: 'help', args: [], options };
  let name = words.shift()!;
  if (groups.has(name)) name += ` ${words.shift() || (name === 'execution' ? 'status' : 'list')}`;
  const spec = specs[name];
  if (!spec) throw new Error('Unknown command. Run rivloom --help.');
  if (words.length !== spec.count) throw new Error(`Wrong number of arguments for '${name}'. Run rivloom --help.`);
  const allowed = new Set(['data-dir', 'json', ...(spec.options || []), ...(spec.switches || [])]);
  if (Object.keys(options).some(key => !allowed.has(key))) throw new Error(`Unsupported option for '${name}'. Run rivloom --help.`);
  return { name, args: words, options };
}

export function dataDirectory(option?: string | true, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = typeof option === 'string' ? option : env.RIVLOOM_DATA_DIR;
  if (explicit) return resolve(explicit);
  // XDG paths must be absolute; ignore relative values as required by XDG.
  return join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share'), 'rivloom');
}

function required(command: Command, key: string): string {
  const value = command.options[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`'${command.name}' requires --${key}`);
  return value;
}
function confirmed(command: Command) {
  if (!command.options.confirm) throw new Error(`'${command.name}' requires --confirm`);
}
function segment(value: string) { return encodeURIComponent(value); }
export function profile(name: string) {
  const result = { name: name.trim(), icon: 'terminal' };
  if (!validNodeProfile(result)) throw new Error('Node name must contain 1–80 characters without control characters.');
  return result;
}
export type API = { request<T = unknown>(path: string, body?: unknown): Promise<T> };
export type CommandIO = { stdin(): Promise<string>; dataDir: string };

export function peerPort(value?: string | true): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('--peer-port must be an integer from 1 to 65535.');
  return Number(value);
}

async function stdin(command: Command, io: CommandIO) {
  if (!command.options.stdin) throw new Error(`'${command.name}' requires --stdin`);
  const text = await io.stdin();
  if (!text.trim()) throw new Error('Standard input is empty.');
  return text.trim();
}
function jsonInput(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error('Standard input must contain valid JSON.'); }
}

/** All routes are fixed here. No user-supplied URL can receive the local credential. */
export async function runCommand(command: Command, api: API, io: CommandIO): Promise<unknown> {
  const { name, args } = command;
  if (name === 'name') return api.request('/api/network/profile', profile(args[0]));
  if (name === 'status') {
    const [state, queue] = await Promise.all([api.request<Bootstrap>('/api/bootstrap'), api.request<NodeQueueSnapshot>('/api/node-queue')]);
    return { online: true, dataDir: io.dataDir, node: state.network.local, network: { status: state.network.status, error: state.network.error, diagnostics: state.network.diagnostics }, engine: { ready: state.engine.ready, version: state.engine.version, error: state.engine.error }, executionPolicy: state.executionPolicy, queue };
  }
  if (name === 'nodes' || name === 'pair list') {
    const network = await api.request<NodeNetwork>('/api/network');
    return { local: network.local, nearby: network.nearby, paired: network.paired || [], pairings: network.pairings, instruction: 'Compare each pairing code on both devices before confirming.' };
  }
  if (name === 'pair request') return api.request('/api/network/pairings', { nodeID: args[0] });
  if (name === 'pair confirm') {
    const code = required(command, 'code');
    const network = await api.request<NodeNetwork>('/api/network');
    const pairing = network.pairings.find(item => item.id === args[0]);
    if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) throw new Error('Pairing is missing or expired. Run rivloom pair list.');
    if (pairing.code !== code) throw new Error('Pairing code does not match. Compare the current code on both devices.');
    return api.request(`/api/network/pairings/${segment(args[0])}/confirm`, {});
  }
  if (name === 'pair cancel') return api.request(`/api/network/pairings/${segment(args[0])}/cancel`, {});
  if (name === 'pair revoke') { confirmed(command); return api.request(`/api/network/trusted/${segment(args[0])}/revoke`, { confirmed: true }); }
  if (name === 'projects list') return (await api.request<Bootstrap>('/api/bootstrap')).projects;
  if (name === 'projects add') {
    confirmed(command);
    return api.request('/api/projects', { name: required(command, 'name'), directory: resolve(args[0]), trusted: true });
  }
  if (name === 'providers list') return api.request('/api/model-settings/providers');
  if (name === 'providers key') {
    confirmed(command);
    if (command.options['account-id'] && !command.options.account) throw new Error('--account-id requires --account NAME');
    const key = await stdin(command, io);
    if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error('API key must be 1–4096 characters without whitespace or control characters.');
    const account = command.options.account ? { name: required(command, 'account'), ...(command.options['account-id'] ? { id: required(command, 'account-id') } : {}) } : undefined;
    return api.request('/api/model-settings/provider/key', { providerID: args[0], key, shared: true, ...(account ? { account } : {}) });
  }
  if (name === 'providers custom') {
    confirmed(command);
    const input = jsonInput(await stdin(command, io));
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'provider') || Object.keys(input).some(key => !['provider', 'key'].includes(key))) throw new Error('Expected {"provider": {...}, "key": "optional API key"} on stdin.');
    return api.request('/api/model-settings/provider/custom', { ...input, shared: true });
  }
  if (name === 'providers remove') { confirmed(command); return api.request('/api/model-settings/provider/remove', { providerID: args[0], confirmed: true }); }
  if (name === 'models list') return api.request('/api/model-settings');
  if (name === 'models default') return api.request('/api/model-settings/default', { model: args[0] });
  if (name === 'execution status') return api.request('/api/network/execution-policy');
  if (name === 'execution concurrency') {
    const maxConcurrent = Number(args[0]);
    if (!/^\d+$/.test(args[0]) || !validRemoteConcurrency(maxConcurrent)) throw new Error('Concurrency must be an integer from 1 to 10.');
    return api.request('/api/network/execution-concurrency', { maxConcurrent });
  }
  if (name === 'execution enable') {
    confirmed(command);
    const approvalMode = required(command, 'approval');
    if (!['ask', 'auto', 'full'].includes(approvalMode)) throw new Error('--approval must be ask, auto or full');
    const thinking = command.options.thinking;
    const reasoningEffort = !thinking || thinking === 'auto' ? null : thinking;
    if (!validReasoningEffort(reasoningEffort)) throw new Error('Invalid thinking level. Use auto or a level from models list.');
    return api.request('/api/network/execution-policy', { enabled: true, reasoningEffort, projectID: required(command, 'project'), model: required(command, 'model'), approvalMode, confirmed: true });
  }
  if (name === 'execution disable') {
    const policy = await api.request<NodeExecutionPolicy>('/api/network/execution-policy');
    return api.request('/api/network/execution-policy', { ...policy, enabled: false, confirmed: true });
  }
  if (name.startsWith('queue ')) {
    const queue = await api.request<NodeQueueSnapshot>('/api/node-queue');
    if (name === 'queue list') return queue;
    return api.request('/api/node-queue/pause', { operationID: randomUUID(), expectedVersion: queue.version, paused: name === 'queue pause' });
  }
  if (name === 'pending') return (await api.request<Bootstrap>('/api/bootstrap')).tasks.filter(task => task.approvals.length || task.questions.length).map(task => ({ taskID: task.id, title: task.title, state: task.state, approvals: task.approvals, questions: task.questions }));
  if (name === 'approve') {
    if (!['once', 'reject'].includes(args[2])) throw new Error('Permission reply must be once or reject.');
    return api.request(`/api/tasks/${segment(args[0])}/permissions/${segment(args[1])}`, { reply: args[2] });
  }
  if (name === 'respond') {
    const answers = jsonInput(await stdin(command, io));
    if (!Array.isArray(answers) || !answers.length || answers.length > 10 || !answers.every(row => Array.isArray(row) && row.length > 0 && row.every(answer => typeof answer === 'string' && answer.length <= 4000))) throw new Error('Answers must be 1–10 nonempty arrays of strings, one array per question.');
    return api.request(`/api/tasks/${segment(args[0])}/questions/${segment(args[1])}`, { answers });
  }
  throw new Error('This command does not use the running node.');
}

/** systemd parses specifiers and ExecStart variables even inside double quotes. */
function unitQuote(value: string, command = false) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Service paths must not contain control characters.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, command ? '$$$$' : '$') }"`;
}
export function systemdUnit(executable: string, dataDir: string, port?: number): string {
  if (!executable.startsWith('/') || !dataDir.startsWith('/')) throw new Error('Service executable and data directory must be absolute Linux paths.');
  if (port !== undefined) peerPort(String(port));
  return `[Unit]\nDescription=Rivloom LAN execution node\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${unitQuote(executable, true)} --data-dir ${unitQuote(dataDir, true)} serve${port === undefined ? '' : ` --peer-port ${port}`}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
