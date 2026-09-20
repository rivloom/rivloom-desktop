import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, help, parseArguments, peerPort, profile, runCommand, systemdUnit } from './commands.ts';
import { HeadlessClient, readControl } from './control.ts';
import { cliHelp, cliText, prepareCliArguments } from './localization.ts';

export function initializeDataDirectory(dataDir: string, name?: string) {
  const local = name === undefined ? undefined : profile(name);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dataDir);
  if (!stat.isDirectory() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Data directory must be private and owned by this user (chmod 700).');
  if (local) {
    if (existsSync(join(dataDir, 'headless-control.json'))) throw new Error('A node control record exists. Use rivloom name NAME while the node is running.');
    const path = join(dataDir, 'node-profiles.json');
    if (existsSync(path)) throw new Error('Node profile already exists. Use rivloom name NAME while the node is running.');
    writeFileSync(path, JSON.stringify({ version: 1, local, peers: {} }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return { initialized: true, dataDir, ...(local ? { name: local.name } : {}), next: 'Run rivloom serve, then manage it from another terminal with the same --data-dir.' };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Use a pipe or file redirection for --stdin. Do not pass secrets as command arguments.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65_536) throw new Error('Standard input exceeds the 64 KiB limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const { args } = prepareCliArguments(argv);
  const command = parseArguments(args);
  if (command.name === 'help') { process.stdout.write(cliHelp(help)); return; }
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  if (command.name === 'version') {
    const { version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
    process.stdout.write((command.options.json ? JSON.stringify({ version }) : version) + '\n');
    return;
  }
  const dataDir = dataDirectory(command.options['data-dir']);
  if (command.name === 'service') {
    const executable = typeof command.options.executable === 'string' ? command.options.executable : resolve(packageRoot, '..', 'bin', 'rivloom');
    process.stdout.write(systemdUnit(executable, dataDir, peerPort(command.options['peer-port'])));
    return;
  }
  if (command.name === 'init') {
    const name = typeof command.options.name === 'string' ? command.options.name : undefined;
    const initialized = initializeDataDirectory(dataDir, name);
    process.stdout.write(JSON.stringify({ ...initialized, next: cliText(initialized.next) }, null, 2) + '\n');
    return;
  }
  if (command.name === 'serve') {
    const port = peerPort(command.options['peer-port']);
    initializeDataDirectory(dataDir);
    process.env.RIVLOOM_HEADLESS = '1';
    process.env.RIVLOOM_DATA_DIR = dataDir;
    process.env.PORT = '0';
    if (port !== undefined) process.env.RIVLOOM_PEER_PORT = String(port);
    process.chdir(packageRoot);
    await import('../server/index.ts');
    return;
  }
  const client = new HeadlessClient(readControl(dataDir));
  try {
    await client.connect();
    const result = await runCommand(command, client, { dataDir, stdin: readStdin });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { await client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`rivloom: ${cliText(error instanceof Error ? error.message : 'Command failed')}\n`);
    process.exitCode = 1;
  });
}
