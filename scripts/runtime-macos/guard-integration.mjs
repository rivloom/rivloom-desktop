import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { macosProcessHelper, parseMacosEngineStopDiagnostic, readMacosProcesses } from "../../server/macos-process.mjs"

const expectedChecks = ["git-path-and-discovery", "shell-and-exit-status", "stdio-extra-fd-and-environment",
  "concurrent-force-kill-isolation", "scope-finalizer-descendant-cleanup", "operation-timeout-descendant-cleanup", "abort-descendant-cleanup"]
const phases = ["configuration", "imports", "git-path", "shell-status", "stdio", "concurrent-cancel", "operation-timeout", "abort", "complete"]
const stages = ["begin", "handle-acquired", "stdout-complete", "stderr-complete", "fd3-complete", "exit-code-observed"]
const stdioEvents = ["started", "fd3-closed", "stdin-data", "stdin-end", "stdout-written", "stderr-written"]
const recipeRoot = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(recipeRoot, "../..")
const hostPath = path.join(desktopRoot, "server/engine-host.mjs")
const processModule = path.join(desktopRoot, "server/macos-process.mjs")
const fixturePath = path.join(recipeRoot, "guard-fixture.mjs")
const config = JSON.parse(readFileSync(path.join(recipeRoot, "runtime.json"), "utf8"))
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex")
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(["--source", "--bun"].includes(process.argv[index]) && !args.has(process.argv[index]))
  assert.ok(process.argv[index + 1] && path.isAbsolute(process.argv[index + 1]))
  args.set(process.argv[index], process.argv[index + 1])
}
assert.equal(args.size, 2)
assert.equal(process.platform, "darwin")
assert.equal(process.arch, "arm64")
assert.equal(process.versions.node, config.nodeVersion)
const root = path.resolve(args.get("--source")), bun = path.resolve(args.get("--bun"))
assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink())
assert.ok(lstatSync(bun).isFile() && !lstatSync(bun).isSymbolicLink())
assert.equal(execFileSync(bun, ["--version"], { encoding: "utf8", timeout: 5000 }).trim(), config.bun.version)
const patch = JSON.parse(readFileSync(path.join(recipeRoot, "core-spawn.patch.json"), "utf8"))
assert.equal(digest(path.join(root, patch.files[0].path)), patch.files[0].afterSHA256)
assert.equal(digest(path.join(root, patch.additions[0].path)), patch.additions[0].sha256)
const integrationPaths = ["native/macos-process.c", "scripts/macos-process-build.ts", "server/engine-host.mjs", "server/macos-process.mjs"]
assert.deepEqual(Object.keys(config.integrationSources ?? {}).sort(), integrationPaths)
for (const relative of integrationPaths) {
  const file = path.join(desktopRoot, relative)
  const stat = lstatSync(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink())
  assert.match(config.integrationSources[relative], /^[a-f0-9]{64}$/)
  assert.equal(digest(file), config.integrationSources[relative], "The actual process boundary must match the reviewed integration source")
}
const helper = macosProcessHelper()
const helperReceiptPath = `${helper}.json`
const helperReceiptStat = lstatSync(helperReceiptPath)
assert.ok(helperReceiptStat.isFile() && !helperReceiptStat.isSymbolicLink() && helperReceiptStat.size <= 32768)
const nativeHelper = JSON.parse(readFileSync(helperReceiptPath, "utf8"))
assert.deepEqual(Object.keys(nativeHelper).sort(), ["arch", "binarySHA256", "inputs", "platform", "schemaVersion"])
assert.equal(nativeHelper.schemaVersion, 1)
assert.equal(nativeHelper.platform, "darwin")
assert.equal(nativeHelper.arch, "arm64")
assert.deepEqual(Object.keys(nativeHelper.inputs).sort(), ["buildScriptSHA256", "compiler", "sdk", "sourceSHA256"])
assert.equal(nativeHelper.inputs.sourceSHA256, config.integrationSources["native/macos-process.c"])
assert.equal(nativeHelper.inputs.buildScriptSHA256, config.integrationSources["scripts/macos-process-build.ts"])
assert.ok(typeof nativeHelper.inputs.compiler === "string" && nativeHelper.inputs.compiler.length > 0 && nativeHelper.inputs.compiler.length <= 8192)
assert.ok(typeof nativeHelper.inputs.sdk === "string" && /^\d+(?:\.\d+){0,3}$/.test(nativeHelper.inputs.sdk))
assert.equal(nativeHelper.binarySHA256, digest(helper))
const directory = await mkdtemp(path.join(tmpdir(), "rivloom-core-guard-"))
await chmod(directory, 0o700)
const reportDirectory = path.join(root, "rivloom/.tools")
await mkdir(reportDirectory, { recursive: true })
assert.ok(lstatSync(reportDirectory).isDirectory() && !lstatSync(reportDirectory).isSymbolicLink())
const reportPath = path.join(reportDirectory, "guard-integration-report.json")
const prior = lstatSync(reportPath, { throwIfNoEntry: false })
assert.ok(!prior || (prior.isFile() && !prior.isSymbolicLink()))
const environment = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: directory, TMPDIR: directory,
  XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"),
  XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state"),
  LANG: "en_US.UTF-8", CI: "true" }
const report = { schemaVersion: 1, passed: false, target: "darwin-arm64", checks: [], nativeHelper,
  inputs: { coreSHA256: patch.files[0].afterSHA256, adapterSHA256: patch.additions[0].sha256,
    integrationSources: config.integrationSources,
    bunVersion: config.bun.version, bunSHA256: digest(bun), helperSHA256: digest(helper),
    hostSHA256: digest(hostPath), processModuleSHA256: digest(processModule),
    fixtureSHA256: digest(fixturePath), harnessSHA256: digest(fileURLToPath(import.meta.url)) } }
let child, output = "", errors = "", overflow = false, complete, fixtureFailure, failurePhase, frozen, closed = false
const events = []
const stageTrace = []
const startedAt = performance.now()
const stdioEvidence = () => {
  const result = { status: "unavailable", events: [] }
  let descriptor
  try {
    const folder = path.join(directory, "stdio-evidence")
    const parent = lstatSync(folder)
    assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid())
    const file = path.join(folder, "stdio-progress.jsonl"), before = lstatSync(file)
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid() && before.size <= 8192)
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(descriptor)
    assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1 && opened.uid === process.getuid() && opened.size <= 8192)
    const buffer = Buffer.alloc(8193), bytes = readSync(descriptor, buffer, 0, buffer.length, 0)
    assert.ok(bytes <= 8192)
    const text = buffer.subarray(0, bytes).toString("utf8")
    // An interrupted append may leave one partial record. Never expose it.
    const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean)
    assert.ok(lines.length <= 64)
    for (const line of lines) {
      const value = JSON.parse(line)
      assert.ok(value && stdioEvents.includes(value.event))
      assert.deepEqual(Object.keys(value).sort(), value.event === "stdin-data" ? ["bytes", "event"] : ["event"])
      if (value.event === "stdin-data") {
        assert.ok(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= 1048576)
        result.events.push({ event: value.event, bytes: value.bytes })
      } else result.events.push({ event: value.event })
    }
    result.status = "read"
    result.partialRecord = text.length > 0 && !text.endsWith("\n")
  } catch { result.status = "unavailable" }
  finally { if (descriptor !== undefined) { try { closeSync(descriptor) } catch { result.status = "unavailable" } } }
  return result
}
const exit = async timeout => {
  const deadline = performance.now() + timeout
  while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await delay(40)
  assert.ok(child.exitCode !== null || child.signalCode !== null, "The actual guarded core fixture exceeded its deadline")
}
const verifyGone = async () => {
  if (!frozen) return
  const deadline = performance.now() + 7000
  while (performance.now() < deadline) {
    const rows = await readMacosProcesses()
    if (!rows.some(row => !row.zombie && (row.session === frozen.session ||
      frozen.identities.some(value => value.pid === row.pid && value.created === row.created)))) return
    await delay(80)
  }
  assert.fail("The core fixture's original engine session survived shutdown")
}
try {
  child = spawn(process.execPath, [hostPath, bun, fixturePath, "--source", root, "--node", process.execPath,
    "--directory", directory, "--process-module", processModule],
  { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] })
  child.stdout.on("data", data => {
    output += data.toString()
    if (output.length > 65536) { overflow = true; if (child.connected) child.disconnect(); return }
    for (let end; (end = output.indexOf("\n")) !== -1;) {
      const line = output.slice(0, end); output = output.slice(end + 1)
      const prefix = "RIVLOOM_MACOS_GUARD_FIXTURE "
      if (!line.startsWith(prefix)) continue
      try { if (events.length < 128) events.push(JSON.parse(line.slice(prefix.length))); else overflow = true } catch { overflow = true }
    }
  })
  child.stderr.on("data", data => { errors = (errors + data.toString()).slice(-65536) })
  child.on("error", () => { fixtureFailure = "host-launch" })
  child.on("close", () => { closed = true })
  const deadline = performance.now() + 45000
  let read = 0
  while (performance.now() < deadline && !complete && !fixtureFailure) {
    while (read < events.length) {
      const event = events[read++]
      if (event.event === "root") {
        assert.ok(!frozen && Number.isSafeInteger(event.rootPID) && Number.isSafeInteger(event.ownerPID))
        const rows = await readMacosProcesses()
        const identities = [event.rootPID, event.ownerPID].map(id => {
          const value = rows.find(row => row.pid === id && !row.zombie)
          assert.ok(value?.created, "Freeze the actual Bun root and native owner before integration work")
          assert.equal(value.session, event.ownerPID)
          return value
        })
        frozen = { session: event.ownerPID, identities }
        await writeFile(path.join(directory, "start"), "go", { flag: "wx", mode: 0o600 })
      } else if (event.event === "stage") {
        assert.deepEqual(Object.keys(event).sort(), ["event", "phase", "stage"])
        assert.ok(phases.includes(event.phase) && stages.includes(event.stage) && stageTrace.length < 32)
        assert.ok(event.stage === "begin" || event.phase === "stdio")
        stageTrace.push({ phase: event.phase, stage: event.stage, elapsedMs: Math.round(performance.now() - startedAt) })
      } else if (event.event === "check") {
        assert.equal(event.name, expectedChecks[report.checks.length])
        report.checks.push(event.name)
      } else if (event.event === "complete") {
        assert.equal(event.passed, true)
        assert.deepEqual(event.checks, expectedChecks)
        complete = true
      } else if (event.event === "failed") {
        fixtureFailure = "core-fixture"
        if (phases.includes(event.phase)) failurePhase = event.phase
      }
      else fixtureFailure = "fixture-protocol"
    }
    assert.equal(overflow, false)
    if (closed) break
    await delay(30)
  }
  if (!complete && !fixtureFailure) fixtureFailure = closed ? "host-closed" : "deadline"
  assert.ok(complete && !fixtureFailure, "Pinned Bun and the patched core spawner must finish every integration check")
  await exit(8000)
  assert.equal(child.exitCode, 0)
  assert.equal(child.signalCode, null)
  await verifyGone()
  const diagnostic = errors.split("\n").map(parseMacosEngineStopDiagnostic).find(Boolean)
  assert.ok(diagnostic && diagnostic.outcome === "ok" && diagnostic.proof === "observed-exit" && diagnostic.failure === "none",
    "The real engine host must prove complete normal shutdown")
  assert.deepEqual(report.checks, expectedChecks)
  report.shutdown = diagnostic
  report.passed = true
} finally {
  report.stageTrace = stageTrace
  if (!report.passed) {
    report.stdioProgressBeforeStop = stdioEvidence()
    if (frozen) {
      try {
        const rows = await readMacosProcesses()
        report.liveBeforeStop = {
          frozenSession: rows.filter(row => !row.zombie && row.session === frozen.session).length,
          frozenIdentities: frozen.identities.filter(value => rows.some(row => !row.zombie && row.pid === value.pid && row.created === value.created)).length,
        }
      } catch { report.liveBeforeStop = { unavailable: true } }
    }
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.disconnect()
    await exit(8000).catch(() => { report.cleanupUnproven = true })
  }
  await verifyGone().catch(() => { report.cleanupUnproven = true })
  if (report.cleanupUnproven) report.passed = false
  if (fixtureFailure) report.failure = fixtureFailure
  if (failurePhase) report.failurePhase = failurePhase
  report.shutdown ??= errors.split("\n").map(parseMacosEngineStopDiagnostic).find(Boolean)
  if (!report.passed) report.retainedFixture = directory
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
  if (report.passed) await rm(directory, { recursive: true, force: true })
}
assert.equal(report.passed, true, "Core guard integration cleanup failed")
console.log(JSON.stringify({ passed: true, checks: report.checks.length, report: reportPath }))
