import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
export const json = (value) => JSON.stringify(value, null, 2) + "\n"
export const sourceGit = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
export const recipeFiles = ["artifact.d.mts", "artifact.mjs", "build.mjs", "core-spawn.patch.json", "guard-fixture.mjs", "guard-integration.mjs", "runtime.json", "smoke.mjs", "source-overlay.d.mts", "source-overlay.mjs", "spawn-guard.ts"]
export const macosOverlayArtifacts = ["compiled-source-files.json", "macos-core-spawn.patch.json", "macos-cross-spawn-spawner.ts", "macos-guard-integration-report.json", "macos-runtime-recipe.json", "macos-source-overlay.json", "macos-spawn-guard.ts"]

export function isolatedSmokeEnvironment(input) {
  const result = Object.fromEntries(Object.entries(input).filter(([key, value]) => typeof value === "string" && (
    ["path", "lang", "lc_all", "lc_ctype"].includes(key.toLowerCase()) ||
    ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].includes(key)
  )))
  const bypass = [...new Set(["127.0.0.1", "localhost", "::1",
    ...[input.NO_PROXY, input.no_proxy].flatMap(value => typeof value === "string" ? value.split(",").map(item => item.trim()).filter(Boolean) : []),
  ])].join(",")
  return { ...result, NO_PROXY: bypass, no_proxy: bypass }
}

export function recipeInventory(directory) {
  const files = Object.fromEntries(recipeFiles.map((file) => {
    const stat = lstatSync(path.join(directory, file))
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Recipe must contain ordinary files: ${file}`)
    return [file, sha256(path.join(directory, file))]
  }))
  return { files, sha256: createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex") }
}

export function verifyMacosBinary(file) {
  const bytes = readFileSync(file)
  assert.ok(bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf, "Expected a thin 64-bit Mach-O executable")
  assert.equal(bytes.readUInt32LE(4), 0x0100000c, "Expected macOS ARM64")
  assert.equal(bytes.readUInt32LE(8), 0, "Expected general ARM64, not ARM64e")
  assert.equal(bytes.readUInt32LE(12), 2, "Expected MH_EXECUTE")
  const commands = bytes.readUInt32LE(16), commandBytes = bytes.readUInt32LE(20)
  assert.ok(commands > 0 && commandBytes >= 8 && commandBytes <= bytes.length - 32, "Invalid Mach-O load commands")
  if (process.platform === "darwin") assert.ok(lstatSync(file).mode & 0o111, "macOS executable permissions missing")
}

export function verifyNativeSignature(file) {
  assert.equal(process.platform, "darwin", "Signature validation requires native macOS")
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", file], { stdio: "pipe", timeout: 30000 })
}

// Git's index supplies portable mode metadata; hashes identify the actual working bytes.
// Ignored dependencies and generated outputs are represented separately by the lock/toolchain.
export function sourceInventory(root, requireClean = false) {
  const status = sourceGit(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
  if (requireClean) assert.equal(status, "", "A committed candidate requires a clean working tree")
  const indexed = sourceGit(root, "ls-files", "--stage", "-z").split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d+) ([a-f\d]+) (\d)\t([\s\S]+)$/)
    assert.ok(match && match[3] === "0", "Unmerged source input")
    assert.notEqual(match[1], "160000", "Submodule inputs need a separately pinned inventory")
    return { path: match[4], mode: match[1], tracked: true }
  })
  const untracked = sourceGit(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
    .map((file) => ({ path: file, mode: "100644", tracked: false }))
  const files = [...indexed, ...untracked].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((entry) => {
    const file = path.resolve(root, entry.path)
    assert.ok(file.startsWith(path.resolve(root) + path.sep), "Source escaped repository")
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) return { ...entry, type: "deleted", bytes: 0, sha256: null }
    assert.ok(stat.isFile() || stat.isSymbolicLink(), `Unsupported source type: ${entry.path}`)
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file)
    return { ...entry, type: stat.isSymbolicLink() ? "symlink" : "file", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }
  })
  return { schemaVersion: 1, commit: sourceGit(root, "rev-parse", "HEAD").trim(),
    tree: sourceGit(root, "rev-parse", "HEAD^{tree}").trim(), dirty: status !== "", status: status.split("\0").filter(Boolean), files }
}

// Both publishing and upstream compilation may rename/remove these trees. Refuse
// symlinks/junctions anywhere in their ancestry or existing contents first.
export function safeDirectory(root, target) {
  const absolute = path.resolve(target)
  assert.ok(absolute.startsWith(path.resolve(root) + path.sep), "Output must stay inside the designated directory")
  for (let current = absolute; ; current = path.dirname(current)) {
    const stat = lstatSync(current, { throwIfNoEntry: false })
    assert.ok(!stat?.isSymbolicLink(), `Refusing linked output ancestor: ${current}`)
    if (current === path.dirname(current)) break
  }
  const visit = (dir) => {
    if (!existsSync(dir)) return
    assert.ok(lstatSync(dir).isDirectory(), `Expected directory: ${dir}`)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), `Refusing linked output: ${path.join(dir, entry.name)}`)
      if (entry.isDirectory()) visit(path.join(dir, entry.name))
    }
  }
  visit(absolute)
  return absolute
}

export function publishDirectory(root, stage, target) {
  safeDirectory(root, stage)
  safeDirectory(root, target)
  if (existsSync(target)) {
    const archive = path.join(root, "archive", `${path.basename(target)}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`)
    safeDirectory(root, archive)
    mkdirSync(path.dirname(archive), { recursive: true })
    renameSync(target, archive)
    console.log(`Previous artifact preserved: ${archive}`)
  }
  renameSync(stage, target)
}

export function writeChecksums(out) {
  const files = ["LICENSE", "README.md", "opencode", "runtime-manifest.json", "smoke-report.json", "source-files.json", ...macosOverlayArtifacts]
    .filter((file) => existsSync(path.join(out, file)))
  writeFileSync(path.join(out, "SHA256SUMS"), files.map((file) => `${sha256(path.join(out, file))}  ${file}\n`).join(""))
}

export function verifyArtifact(out, manifest) {
  assert.equal(manifest.schemaVersion, 2, "Rebuild this candidate using the current producer before verification")
  assert.equal(manifest.target, "darwin-arm64")
  assert.equal(manifest.profile.baseline, false)
  assert.equal(manifest.profile.libc, undefined)
  assert.equal(manifest.profile.signed, true)
  assert.equal(manifest.profile.signingIdentity, "ad-hoc")
  assert.equal(manifest.binary.file, "opencode")
  assert.deepEqual(manifest.artifacts.map((file) => file.file).sort(), ["LICENSE", "README.md", ...macosOverlayArtifacts, "source-files.json"].sort())
  for (const artifact of [manifest.binary, ...manifest.artifacts]) {
    assert.equal(path.basename(artifact.file), artifact.file, "Artifact path must be a filename")
    const file = path.join(out, artifact.file)
    assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), "Artifact must be an ordinary file")
    assert.equal(readFileSync(file).length, artifact.bytes, `Artifact size changed: ${artifact.file}`)
    assert.equal(sha256(file), artifact.sha256, `Artifact changed: ${artifact.file}`)
  }
  const inventory = JSON.parse(readFileSync(path.join(out, "source-files.json"), "utf8"))
  assert.equal(manifest.source.inventory.file, "source-files.json")
  assert.equal(sha256(path.join(out, "source-files.json")), manifest.source.inventory.sha256)
  for (const key of ["commit", "tree", "dirty"]) assert.equal(inventory[key], manifest.source[key])
  assert.equal(inventory.files.length, manifest.source.inventory.files)
  assert.equal(inventory.dirty, false, "macOS candidates require clean pinned core source")
  const sourceFiles = new Map(inventory.files.map((file) => [file.path, file.sha256]))
  for (const [file, hash] of Object.entries(manifest.inputs.files)) assert.equal(sourceFiles.get(file), hash, `Source input disagrees: ${file}`)
  assert.equal(sourceFiles.get("bun.lock"), manifest.inputs.bunLockSHA256)
  assert.equal(sourceFiles.get("rivloom/models.json"), manifest.inputs.modelsSHA256)
  assert.equal(sourceFiles.get("LICENSE"), manifest.artifacts.find((file) => file.file === "LICENSE").sha256)
  assert.equal(sourceFiles.get("rivloom/README.md"), manifest.artifacts.find((file) => file.file === "README.md").sha256)
  const patch = JSON.parse(readFileSync(path.join(out, "macos-core-spawn.patch.json"), "utf8"))
  const compiled = JSON.parse(readFileSync(path.join(out, "compiled-source-files.json"), "utf8"))
  const overlay = JSON.parse(readFileSync(path.join(out, "macos-source-overlay.json"), "utf8"))
  assert.equal(sha256(path.join(out, "macos-core-spawn.patch.json")), manifest.recipe.files["core-spawn.patch.json"])
  assert.equal(sha256(path.join(out, "macos-spawn-guard.ts")), manifest.recipe.files["spawn-guard.ts"])
  assert.equal(patch.baseCommit, inventory.commit); assert.equal(patch.target, "darwin-arm64")
  assert.deepEqual(patch.files.map(file => file.path), ["packages/core/src/cross-spawn-spawner.ts"])
  assert.deepEqual(patch.additions.map(file => [file.path, file.source]), [["packages/core/src/rivloom-macos-guard.ts", "spawn-guard.ts"]])
  assert.equal(sourceFiles.get(patch.files[0].path), patch.files[0].beforeSHA256)
  assert.equal(sha256(path.join(out, "macos-cross-spawn-spawner.ts")), patch.files[0].afterSHA256)
  assert.equal(sha256(path.join(out, "macos-spawn-guard.ts")), patch.additions[0].sha256)
  const expected = inventory.files.map(file => file.path === patch.files[0].path ? { ...file, sha256: patch.files[0].afterSHA256, bytes: readFileSync(path.join(out, "macos-cross-spawn-spawner.ts")).length } : file)
  expected.push({ path: patch.additions[0].path, mode: "100644", tracked: false, type: "file", bytes: readFileSync(path.join(out, "macos-spawn-guard.ts")).length, sha256: patch.additions[0].sha256 })
  expected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assert.deepEqual(compiled, { ...inventory, dirty: true, status: [` M ${patch.files[0].path}`, `?? ${patch.additions[0].path}`], files: expected })
  const inventoryDigest = files => createHash("sha256").update(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => [file.path, file.mode, file.sha256]))).digest("hex")
  assert.deepEqual(overlay, { schemaVersion: 1, kind: "rivloom-macos-source-overlay", baseCommit: inventory.commit, baseTree: inventory.tree,
    baseInventorySHA256: inventoryDigest(inventory.files), compiledInventorySHA256: inventoryDigest(compiled.files),
    patch: { file: "macos-core-spawn.patch.json", sha256: manifest.recipe.files["core-spawn.patch.json"] },
    files: [{ path: patch.files[0].path, beforeSHA256: patch.files[0].beforeSHA256, afterSHA256: patch.files[0].afterSHA256, artifact: "macos-cross-spawn-spawner.ts" }],
    additions: [{ path: patch.additions[0].path, sha256: patch.additions[0].sha256, artifact: "macos-spawn-guard.ts" }] })
  const config = JSON.parse(readFileSync(path.join(out, "macos-runtime-recipe.json"), "utf8"))
  assert.equal(sha256(path.join(out, "macos-runtime-recipe.json")), manifest.recipe.files["runtime.json"])
  assert.deepEqual(config.sourceOverlay, { patch: { file: "core-spawn.patch.json", sha256: manifest.recipe.files["core-spawn.patch.json"] },
    module: { file: "spawn-guard.ts", sha256: patch.additions[0].sha256 } })
  assert.deepEqual(Object.keys(config.integrationSources).sort(), ["native/macos-process.c", "scripts/macos-process-build.ts", "server/engine-host.mjs", "server/macos-process.mjs"])
  for (const hash of Object.values(config.integrationSources)) assert.match(hash, /^[a-f0-9]{64}$/)
  const integration = JSON.parse(readFileSync(path.join(out, "macos-guard-integration-report.json"), "utf8"))
  assert.equal(integration.schemaVersion, 1); assert.equal(integration.target, "darwin-arm64"); assert.equal(integration.passed, true)
  assert.ok(!integration.failure && !integration.cleanupUnproven && !integration.retainedFixture, "Mac core guard integration did not finish cleanly")
  assert.deepEqual(integration.checks, ["git-path-and-discovery", "shell-and-exit-status", "stdio-extra-fd-and-environment", "concurrent-force-kill-isolation", "scope-finalizer-descendant-cleanup", "operation-timeout-descendant-cleanup", "abort-descendant-cleanup"])
  const helper = integration.nativeHelper
  assert.deepEqual(integration.inputs, { coreSHA256: patch.files[0].afterSHA256, adapterSHA256: patch.additions[0].sha256,
    integrationSources: config.integrationSources,
    bunVersion: manifest.toolchain.bun, bunSHA256: manifest.toolchain.bunExecutableSHA256, helperSHA256: helper?.binarySHA256,
    hostSHA256: config.integrationSources["server/engine-host.mjs"], processModuleSHA256: config.integrationSources["server/macos-process.mjs"],
    fixtureSHA256: manifest.recipe.files["guard-fixture.mjs"], harnessSHA256: manifest.recipe.files["guard-integration.mjs"] })
  assert.deepEqual(Object.keys(helper).sort(), ["arch", "binarySHA256", "inputs", "platform", "schemaVersion"])
  assert.deepEqual(Object.keys(helper.inputs).sort(), ["buildScriptSHA256", "compiler", "sdk", "sourceSHA256"])
  assert.equal(helper.schemaVersion, 1); assert.equal(helper.platform, "darwin"); assert.equal(helper.arch, "arm64")
  assert.match(helper.binarySHA256, /^[a-f0-9]{64}$/)
  assert.ok(typeof helper.inputs.compiler === "string" && helper.inputs.compiler.length > 0 && helper.inputs.compiler.length <= 8192)
  assert.match(helper.inputs.sdk, /^\d+(?:\.\d+){0,3}$/)
  assert.equal(helper.inputs.sourceSHA256, config.integrationSources["native/macos-process.c"])
  assert.equal(helper.inputs.buildScriptSHA256, config.integrationSources["scripts/macos-process-build.ts"])
  const stop = integration.shutdown
  assert.ok(stop && stop.phase === "result" && stop.outcome === "ok" && stop.proof === "observed-exit" && stop.failure === "none" &&
    Number.isSafeInteger(stop.recorded) && stop.recorded > 0 && Number.isSafeInteger(stop.durationMs) && stop.durationMs >= 0 && !stop.inventoryFailure && !stop.ownershipFailure,
  "Mac native integration lacks proven owned-process shutdown")
  assert.deepEqual(manifest.source.compilation, { kind: "macos-source-overlay",
    inventory: { file: "compiled-source-files.json", sha256: sha256(path.join(out, "compiled-source-files.json")), files: compiled.files.length },
    overlay: { file: "macos-source-overlay.json", sha256: sha256(path.join(out, "macos-source-overlay.json")) },
    integration: { file: "macos-guard-integration-report.json", sha256: sha256(path.join(out, "macos-guard-integration-report.json")) },
    recipe: { file: "macos-runtime-recipe.json", sha256: sha256(path.join(out, "macos-runtime-recipe.json")) } })
  verifyMacosBinary(path.join(out, "opencode"))
  return manifest
}

export function installedPackageVersion(file) {
  try { return JSON.parse(readFileSync(file, "utf8")).version } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
}
