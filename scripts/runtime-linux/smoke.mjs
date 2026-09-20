import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { installedPackageVersion, isolatedSmokeEnvironment, json, recipeInventory, safeDirectory, sha256, sourceInventory, verifyArtifact, verifyLinuxBinary, writeChecksums } from "./artifact.mjs"

const recipeRoot = path.dirname(fileURLToPath(import.meta.url))
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(["--source", "--artifact"].includes(process.argv[index]) && !args.has(process.argv[index]) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), "Use --source <clean checkout> --artifact <Linux candidate>")
  args.set(process.argv[index], process.argv[index + 1])
}
assert.ok(args.has("--source") && args.has("--artifact"), "An explicit source and artifact are required")
assert.equal(process.platform, "linux", "Linux verification requires native Linux")
assert.equal(process.arch, "x64")
const root = path.resolve(args.get("--source"))
const out = path.resolve(args.get("--artifact"))
safeDirectory(path.dirname(out), out)
const exe = path.join(out, "opencode")
const manifest = JSON.parse(readFileSync(path.join(out, "runtime-manifest.json"), "utf8"))
verifyArtifact(out, manifest)
const recipe = recipeInventory(recipeRoot)
assert.deepEqual(manifest.recipe, recipe, "Use the candidate's exact reviewed recipe")
const recipeConfig = JSON.parse(readFileSync(path.join(recipeRoot, "runtime.json"), "utf8"))
assert.equal(process.versions.node, recipeConfig.nodeVersion)
assert.equal(manifest.source.commit, recipeConfig.source.commit)
assert.equal(manifest.source.tree, recipeConfig.source.tree)
assert.deepEqual(manifest.inputs.files, recipeConfig.inputs)
const source = sourceInventory(root, true)
assert.equal(createHash("sha256").update(json(source)).digest("hex"), manifest.source.inventory.sha256, "Smoke source differs from compiled source")
const manifestSHA256 = sha256(path.join(out, "runtime-manifest.json"))
assert.equal(sha256(path.join(root, "rivloom/models.json")), manifest.inputs.modelsSHA256)
const diagnostics = path.join(root, "rivloom/dist/verification")
safeDirectory(path.join(root, "rivloom/dist"), path.join(diagnostics, "smoke-"))
mkdirSync(diagnostics, { recursive: true })
const temp = mkdtempSync(path.join(diagnostics, "linux-smoke-"))
const project = path.join(temp, "project")
const home = path.join(temp, "home")
for (const dir of [project, home, "tmp", "data", "cache", "config", "state", "managed"].map((dir) =>
  path.isAbsolute(dir) ? dir : path.join(temp, dir),
)) {
  mkdirSync(dir, { recursive: true })
}
const report = {
  schemaVersion: 2,
  version: manifest.version,
  binarySHA256: manifest.binary.sha256,
  manifestSHA256,
  sourceInventorySHA256: manifest.source.inventory.sha256,
  licenseSHA256: manifest.artifacts.find((file) => file.file === "LICENSE").sha256,
  harnessSHA256: sha256(fileURLToPath(import.meta.url)),
  recipeSHA256: recipe.sha256,
  startedAt: new Date().toISOString(),
  passed: false,
  checks: [],
}
const check = async (name, fn) => {
  const started = Date.now()
  await fn()
  report.checks.push({ name, passed: true, durationMs: Date.now() - started })
  console.log(`PASS ${name}`)
}
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await delay(150)
  }
  throw new Error(`Timed out: ${label}`)
}

let mode = "chat"
let toolFile = ""
let requests = 0
let held = 0
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions")
    assert.equal(req.method, "POST")
    let raw = ""
    for await (const chunk of req) raw += chunk
    const input = JSON.parse(raw)
    requests++
    if (mode === "hold" && input.stream) {
      held++
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.write(": waiting for cancellation\n\n")
      return
    }
    const canWrite = input.tools?.some((tool) => tool.function?.name === "write")
    const usedTool = input.messages.some((message) => message.role === "tool")
    const tool = mode === "write" && canWrite && !usedTool
    const content = "RIVLOOM_RUNTIME_FIXTURE_OK"
    const call = {
      id: "call_rivloom_fixture",
      type: "function",
      function: {
        name: "write",
        arguments: JSON.stringify({ filePath: toolFile, content: "Rivloom isolated runtime fixture\n" }),
      },
    }
    const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    const base = { id: "chatcmpl-rivloom-fixture", model: input.model, created: Math.floor(Date.now() / 1000) }
    if (!input.stream) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage,
        }),
      )
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const send = (delta, finish_reason, tokens) =>
      res.write(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(tokens ? { usage } : {}) })}\n\n`,
      )
    send(tool ? { role: "assistant", tool_calls: [{ index: 0, ...call }] } : { role: "assistant", content }, null)
    send({}, tool ? "tool_calls" : "stop", true)
    res.end("data: [DONE]\n\n")
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
})
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve))
const password = randomBytes(24).toString("hex")
const authorization = `Basic ${Buffer.from(`rivloom:${password}`).toString("base64")}`
const config = {
  enabled_providers: ["rivloom-fixture"],
  model: "rivloom-fixture/test",
  small_model: "rivloom-fixture/test",
  snapshot: false,
  autoupdate: false,
  share: "disabled",
  plugin: [],
  permission: { "*": "deny", read: "allow", edit: "ask" },
  provider: {
    "rivloom-fixture": {
      name: "Rivloom local fixture",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "local-test-only", timeout: 120000 },
      models: {
        test: {
          name: "Isolated fixture",
          tool_call: true,
          limit: { context: 32000, output: 1000 },
          cost: { input: 0, output: 0 },
        },
      },
    },
  },
}
const env = isolatedSmokeEnvironment(process.env)
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, "AppData/Roaming"),
  LOCALAPPDATA: path.join(home, "AppData/Local"),
  TEMP: path.join(temp, "tmp"),
  TMP: path.join(temp, "tmp"),
  XDG_DATA_HOME: path.join(temp, "data"),
  XDG_CACHE_HOME: path.join(temp, "cache"),
  XDG_CONFIG_HOME: path.join(temp, "config"),
  XDG_STATE_HOME: path.join(temp, "state"),
  OPENCODE_TEST_HOME: home,
  OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(temp, "managed"),
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
  OPENCODE_MODELS_PATH: path.join(root, "rivloom/models.json"),
  OPENCODE_SERVER_USERNAME: "rivloom",
  OPENCODE_SERVER_PASSWORD: password,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
})
let child
let baseURL
let log = ""
let events = []
let eventController
let eventTask
const appendLog = (chunk) => {
  log = (log + chunk.toString().replaceAll(password, "[redacted]")).slice(-150000)
}
async function request(route, { method = "GET", body, auth = true } = {}) {
  const url = new URL(route, baseURL)
  url.searchParams.set("directory", project)
  const res = await fetch(url, {
    method,
    headers: {
      ...(auth ? { authorization } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data }
}
async function api(route, options) {
  const res = await request(route, options)
  assert.ok(res.status >= 200 && res.status < 300, `${route}: HTTP ${res.status} ${JSON.stringify(res.data)}`)
  return res.data
}
async function start() {
  let startup = ""
  child = spawn(exe, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: project,
    env,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.on("error", appendLog)
  child.stdout.on("data", (chunk) => {
    startup += chunk
    appendLog(chunk)
  })
  child.stderr.on("data", appendLog)
  baseURL = await until(
    () => {
      assert.equal(child.exitCode, null, `Runtime exited: ${log}`)
      return startup.match(/opencode server listening on (http:\/\/[^\s]+)/)?.[1]
    },
    "runtime listening",
    60000,
  )
  await until(async () => {
    try {
      return (await request("/global/health")).status === 200
    } catch {
      return false
    }
  }, "runtime health")
}
async function stop() {
  eventController?.abort()
  await eventTask
  if (!child || child.exitCode !== null) return
  const current = child
  const ended = new Promise((resolve) => current.once("exit", resolve))
  // This detached process group belongs to this test, including any npm children.
  process.kill(-current.pid, "SIGTERM")
  if (!(await Promise.race([ended.then(() => true), delay(10000).then(() => false)]))) {
    process.kill(-current.pid, "SIGKILL")
    await ended
  }
  child = undefined
}
async function streamEvents() {
  eventController = new AbortController()
  const url = new URL("/event", baseURL)
  url.searchParams.set("directory", project)
  const res = await fetch(url, { headers: { authorization }, signal: eventController.signal })
  assert.equal(res.status, 200)
  eventTask = (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n")
      let end
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        for (const line of block.split("\n"))
          if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()))
      }
    }
  })().catch((error) => {
    if (!eventController.signal.aborted) throw error
  })
  // Observe failures immediately, while still rethrowing them when stopping.
  eventTask.catch(() => {})
  await until(() => events.some((event) => event.type === "server.connected"), "SSE connection")
}
async function prompt(sessionID, text) {
  const result = await request(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    body: { model: { providerID: "rivloom-fixture", modelID: "test" }, parts: [{ type: "text", text }] },
  })
  assert.equal(result.status, 204, JSON.stringify(result.data))
}
async function completed(sessionID) {
  return until(async () => {
    const messages = await api(`/session/${sessionID}/message`)
    const last = messages.findLast((message) => message.info.role === "assistant")
    if (last?.info.error) throw new Error(JSON.stringify(last.info.error))
    return last?.info.time?.completed &&
      last.parts.some((part) => part.type === "text" && part.text.includes("RIVLOOM_RUNTIME_FIXTURE_OK"))
      ? messages
      : false
  }, "completed model response")
}
const sessionIDs = []
try {
  await check("Linux x64 baseline executable identity and SHA256", () => {
    const bytes = readFileSync(exe)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.binary.sha256)
    verifyLinuxBinary(exe)
    assert.equal(
      execFileSync(exe, ["--version"], {
        cwd: project,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      }).trim(),
      manifest.version,
    )
  })
  await check("HTTP startup, health version and Basic authentication", async () => {
    await start()
    const health = await api("/global/health")
    assert.equal(health.healthy, true)
    assert.equal(health.version, manifest.version)
    assert.equal((await request("/global/health", { auth: false })).status, 401)
  })
  await check("Isolated provider/model discovery", async () => {
    const providers = await api("/provider")
    assert.deepEqual(
      providers.all.map((item) => item.id),
      ["rivloom-fixture"],
    )
    assert.ok(providers.all[0].models.test)
  })
  await check("Session creation, local model streaming and SSE events", async () => {
    await streamEvents()
    const session = await api("/session", { method: "POST", body: { title: "Rivloom runtime fixture" } })
    sessionIDs.push(session.id)
    await prompt(session.id, "Return the fixture success marker.")
    await completed(session.id)
    await until(() => events.some((event) => event.type === "message.part.delta"), "message streaming event")
    assert.ok(requests > 0)
  })
  for (const reply of ["once", "reject"]) {
    await check(`Tool permission ${reply === "once" ? "approval" : "denial"}`, async () => {
      mode = "write"
      toolFile = path.join(project, `${reply}.txt`)
      const session = await api("/session", { method: "POST", body: { title: `Permission ${reply}` } })
      sessionIDs.push(session.id)
      await prompt(session.id, "Run the fixture write tool once, then report the result.")
      const pending = await until(
        async () => (await api("/permission")).find((item) => item.sessionID === session.id),
        "pending tool permission",
      )
      assert.equal(existsSync(toolFile), false, "Tool executed before approval")
      await api(`/permission/${pending.id}/reply`, { method: "POST", body: { reply } })
      if (reply === "once") await completed(session.id)
      else
        await until(async () => {
          const messages = await api(`/session/${session.id}/message`)
          const denied = messages.some((message) =>
            message.parts.some(
              (part) => part.type === "tool" && part.state.status === "error" && /reject/i.test(part.state.error),
            ),
          )
          const statuses = await api("/session/status")
          return denied && (!statuses[session.id] || statuses[session.id].type === "idle")
        }, "rejected tool and idle session")
      assert.equal(existsSync(toolFile), reply === "once")
      if (reply === "once") assert.equal(readFileSync(toolFile, "utf8"), "Rivloom isolated runtime fixture\n")
    })
  }
  await check("Cancellation of an active streaming model request", async () => {
    mode = "hold"
    const session = await api("/session", { method: "POST", body: { title: "Cancellation" } })
    sessionIDs.push(session.id)
    await prompt(session.id, "Wait until cancelled.")
    await until(() => held > 0, "active held model request")
    await api(`/session/${session.id}/abort`, { method: "POST" })
    await until(async () => {
      const messages = await api(`/session/${session.id}/message`)
      return messages.some((message) => message.info.error?.name === "MessageAbortedError")
    }, "persisted cancellation")
    mode = "chat"
  })
  await check("Session and message persistence across process restart", async () => {
    await stop()
    await start()
    assert.equal((await api(`/session/${sessionIDs[0]}`)).id, sessionIDs[0])
    await completed(sessionIDs[0])
  })
  await check("Test session deletion", async () => {
    for (const id of sessionIDs) await api(`/session/${id}`, { method: "DELETE" })
    assert.equal((await request(`/session/${sessionIDs[0]}`)).status, 404)
  })
  await check("Fork plugin dependency resolves to the published baseline", async () => {
    const pkg = path.join(temp, "config/opencode/node_modules/@opencode-ai/plugin/package.json")
    // npm can expose package.json before the final bytes have reached disk.
    await until(() => installedPackageVersion(pkg) === manifest.packageVersions.plugin, "complete baseline plugin installation", 180000)
    assert.ok(!log.includes("background dependency install failed"), "Background plugin dependency failed")
  })
  await check("Manifest, source inventory and license remain bound to the tested executable", () => {
    assert.equal(sha256(path.join(out, "runtime-manifest.json")), manifestSHA256)
    verifyArtifact(out, manifest)
    assert.deepEqual(recipeInventory(recipeRoot), recipe, "Recipe changed during smoke verification")
    assert.deepEqual(sourceInventory(root, true), source, "Core source changed during smoke verification")
  })
  report.passed = true
} catch (error) {
  report.error = error.stack ?? String(error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  try {
    await stop()
  } catch (error) {
    report.cleanupError = String(error)
    report.passed = false
    process.exitCode = 1
  }
  model.closeAllConnections()
  await new Promise((resolve) => model.close(resolve))
  report.finishedAt = new Date().toISOString()
  report.localModelRequests = requests
  report.eventTypes = [...new Set(events.map((event) => event.type))].sort()
  writeFileSync(path.join(temp, "engine.log"), log)
  writeFileSync(path.join(temp, "smoke-report.json"), JSON.stringify(report, null, 2) + "\n")
  if (report.passed && !existsSync(path.join(out, "smoke-report.json"))) {
    writeFileSync(path.join(out, "smoke-report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
    writeChecksums(out)
  }
  console.log(`Verification evidence: ${temp}`)
  console.log(`Runtime verification ${report.passed ? "PASSED" : "FAILED"}: ${report.checks.length} checks`)
}
