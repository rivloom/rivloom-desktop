import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFile, realpath } from "node:fs/promises"
import { writeSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const checks = []
let phase = "configuration"
const emit = value => writeSync(1, `RIVLOOM_MACOS_GUARD_FIXTURE ${JSON.stringify(value)}\n`)

async function main() {
  assert.equal(process.platform, "darwin")
  assert.equal(process.arch, "arm64")
  assert.ok(process.versions.bun, "This fixture must use the pinned Bun executable")
  assert.ok(process.env.RIVLOOM_MACOS_PROCESS_HELPER && process.env.RIVLOOM_MACOS_PROCESS_SOCKET)
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) {
    assert.ok(["--source", "--node", "--directory", "--process-module"].includes(process.argv[index]) && !args.has(process.argv[index]))
    assert.ok(process.argv[index + 1] && path.isAbsolute(process.argv[index + 1]))
    args.set(process.argv[index], process.argv[index + 1])
  }
  assert.equal(args.size, 4)
  const root = args.get("--source"), node = args.get("--node"), directory = args.get("--directory")
  emit({ event: "root", rootPID: process.pid, ownerPID: process.ppid })
  const startDeadline = performance.now() + 5000
  let released = false
  while (performance.now() < startDeadline && !released) {
    try { released = await readFile(path.join(directory, "start"), "utf8") === "go" } catch { /* Parent is still freezing the root identity. */ }
    if (!released) await delay(20)
  }
  assert.ok(released, "The parent must freeze the engine identity before any managed command starts")
  phase = "imports"
  // Resolve the exact dependency graph installed for the source being compiled,
  // rather than a second Effect copy from the desktop or recipe directory.
  const sourceRequire = createRequire(path.join(root, "packages/core/package.json"))
  const { Effect, Exit, Option, Stream } = await import(pathToFileURL(sourceRequire.resolve("effect")).href)
  const { ChildProcess, ChildProcessSpawner } = await import(pathToFileURL(sourceRequire.resolve("effect/unstable/process")).href)
  const CrossSpawnSpawner = await import(pathToFileURL(path.join(root, "packages/core/src/cross-spawn-spawner.ts")).href)
  const LayerNode = await import(pathToFileURL(path.join(root, "packages/core/src/effect/layer-node.ts")).href)
  const { readMacosProcesses } = await import(pathToFileURL(args.get("--process-module")).href)
  const layer = LayerNode.compile(CrossSpawnSpawner.node)
  const run = (effect, signal) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)), { signal })
  const text = stream => Stream.runCollect(stream).pipe(Effect.map(chunks => Buffer.concat(chunks.map(value => Buffer.from(value))).toString("utf8")))
  const pass = name => { checks.push(name); emit({ event: "check", name }) }

  phase = "git-path"
  const git = await run(ChildProcessSpawner.ChildProcessSpawner.use(service => service.string(
    ChildProcess.make("git", ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], { cwd: root, stdin: "ignore" }),
  )))
  assert.equal(await realpath(git.split(/\r?\n/)[0]), await realpath(root))
  pass("git-path-and-discovery")

  phase = "shell-status"
  await run(Effect.gen(function* () {
    const handle = yield* ChildProcess.make("printf", ["shell-output;", "exit", "37"], { shell: true, stdin: "ignore" })
    assert.equal(yield* text(handle.stdout), "shell-output")
    assert.equal(yield* handle.exitCode, 37)
  }))
  pass("shell-and-exit-status")

  phase = "stdio"
  await run(Effect.gen(function* () {
    const code = `
      const fs = require('node:fs'); let input = '';
      fs.writeSync(3, 'additional-output\\n'); fs.closeSync(3);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', value => input += value);
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({input,ordinary:process.env.ONLY_FIXTURE_VALUE,
          privateAbsent:!('RIVLOOM_MACOS_PROCESS_HELPER' in process.env) && !('RIVLOOM_MACOS_PROCESS_SOCKET' in process.env),
          inheritedHome:'HOME' in process.env}));
        process.stderr.write('stderr-output\\n');
      });
    `
    const handle = yield* ChildProcess.make(node, ["-e", code], {
      stdin: Stream.make(Buffer.from("input-through-effect\n")),
      env: { ONLY_FIXTURE_VALUE: "kept" }, extendEnv: false,
      additionalFds: { fd3: { type: "output" } },
    })
    const [out, error, extra] = yield* Effect.all([text(handle.stdout), text(handle.stderr), text(handle.getOutputFd(3))], { concurrency: 3 })
    assert.deepEqual(JSON.parse(out), { input: "input-through-effect\n", ordinary: "kept", privateAbsent: true, inheritedHome: false })
    assert.equal(error, "stderr-output\n")
    assert.equal(extra, "additional-output\n")
    assert.equal(yield* handle.exitCode, 0)
  }))
  pass("stdio-extra-fd-and-environment")

  let fixtureIndex = 0
  const longCommand = () => {
    const evidencePath = path.join(directory, `command-${++fixtureIndex}.json`)
    const code = `
      const fs = require('node:fs'); const {spawn} = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e',
        'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000)'],
        {stdio:['ignore','pipe','ignore']});
      child.stdout.once('data', () => fs.writeFileSync(${JSON.stringify(evidencePath)},
        JSON.stringify({guard:process.ppid,target:process.pid,grandchild:child.pid}), {mode:0o600}));
      setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000);
    `
    return { evidencePath, command: ChildProcess.make(node, ["-e", code], { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: 150 }) }
  }
  const readyFile = async file => {
    const deadline = performance.now() + 5000
    let value
    while (performance.now() < deadline) {
      try { value = JSON.parse(await readFile(file, "utf8")); break } catch { await delay(25) }
    }
    assert.ok(value, "The actual command and grandchild must report readiness")
    return value
  }
  const capture = async file => {
    const value = await readyFile(file)
    const rows = await readMacosProcesses()
    const identities = [value.guard, value.target, value.grandchild].map(id => {
      assert.ok(Number.isSafeInteger(id) && id > 1)
      const row = rows.find(item => item.pid === id && !item.zombie)
      assert.ok(row?.created, "Freeze the real process incarnation before cancellation")
      assert.equal(row.session, value.guard)
      assert.equal(row.group, value.guard)
      return row
    })
    return { session: value.guard, identities }
  }
  const proveGone = async frozen => {
    const deadline = performance.now() + 3500
    while (performance.now() < deadline) {
      const rows = await readMacosProcesses()
      if (!rows.some(row => !row.zombie && (row.session === frozen.session ||
        frozen.identities.some(item => item.pid === row.pid && item.created === row.created)))) return
      await delay(50)
    }
    assert.fail("The actual guard, target or grandchild survived cancellation")
  }
  const alive = async frozen => {
    const rows = await readMacosProcesses()
    for (const item of frozen.identities) assert.ok(rows.some(row => row.pid === item.pid && row.created === item.created && !row.zombie),
      "Cancelling another command must preserve this exact process incarnation")
  }

  phase = "concurrent-cancel"
  let second
  await run(Effect.gen(function* () {
    const a = longCommand(), b = longCommand()
    const firstHandle = yield* a.command
    yield* b.command
    yield* Effect.promise(() => Promise.all([readyFile(a.evidencePath), readyFile(b.evidencePath)]))
    const first = yield* Effect.promise(() => capture(a.evidencePath))
    second = yield* Effect.promise(() => capture(b.evidencePath))
    const started = performance.now()
    yield* firstHandle.kill({ forceKillAfter: 150 })
    assert.ok(performance.now() - started < 4000, "Cancellation must finish before fixture containment timers")
    const status = yield* Effect.exit(firstHandle.exitCode)
    assert.ok(Exit.isFailure(status) || status.value !== 0)
    yield* Effect.promise(() => proveGone(first))
    yield* Effect.promise(() => alive(second))
    // Exiting this scope exercises the spawner's separate finalizer path for B.
  }))
  await proveGone(second)
  pass("concurrent-force-kill-isolation")
  pass("scope-finalizer-descendant-cleanup")

  phase = "operation-timeout"
  let timedOut
  const timeoutResult = await run(Effect.gen(function* () {
    const value = longCommand()
    const handle = yield* value.command
    timedOut = yield* Effect.promise(() => capture(value.evidencePath))
    return yield* handle.exitCode.pipe(Effect.timeoutOption(150))
  }))
  assert.ok(Option.isNone(timeoutResult), "A real running command must exceed the operation deadline")
  await proveGone(timedOut)
  pass("operation-timeout-descendant-cleanup")

  phase = "abort"
  const abort = new AbortController()
  let aborted
  let interrupted = false
  try {
    await run(Effect.gen(function* () {
      const value = longCommand()
      yield* value.command
      aborted = yield* Effect.promise(() => capture(value.evidencePath))
      yield* Effect.sync(() => abort.abort())
      yield* Effect.never
    }), abort.signal)
  } catch { interrupted = true }
  assert.ok(interrupted && aborted, "Abort must interrupt a real already-started command")
  await proveGone(aborted)
  pass("abort-descendant-cleanup")

  phase = "complete"
  emit({ event: "complete", passed: true, checks })
}

try { await main(); process.exit(0) }
catch { emit({ event: "failed", phase, checks }); process.exit(1) }
