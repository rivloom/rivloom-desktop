import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
export const json = (value) => JSON.stringify(value, null, 2) + "\n"
export const sourceGit = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
export const recipeFiles = ["artifact.mjs", "build.mjs", "runtime.json", "smoke.mjs"]

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

export function verifyLinuxBinary(file) {
  const bytes = readFileSync(file)
  assert.ok(bytes.length >= 64 && bytes.toString("hex", 0, 4) === "7f454c46", "Expected an ELF executable")
  assert.equal(bytes[4], 2, "Expected ELF64")
  assert.equal(bytes[5], 1, "Expected little-endian ELF")
  assert.equal(bytes.readUInt16LE(18), 62, "Expected Linux x86-64 ELF")
  assert.ok([2, 3].includes(bytes.readUInt16LE(16)), "Expected executable or PIE ELF")
  if (process.platform !== "win32") assert.ok(lstatSync(file).mode & 0o111, "Linux executable permissions missing")
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
  const files = ["LICENSE", "README.md", "opencode", "runtime-manifest.json", "smoke-report.json", "source-files.json"]
    .filter((file) => existsSync(path.join(out, file)))
  writeFileSync(path.join(out, "SHA256SUMS"), files.map((file) => `${sha256(path.join(out, file))}  ${file}\n`).join(""))
}

export function verifyArtifact(out, manifest) {
  assert.equal(manifest.schemaVersion, 2, "Rebuild this candidate using the current producer before verification")
  assert.equal(manifest.target, "linux-x64")
  assert.equal(manifest.profile.baseline, true)
  assert.equal(manifest.profile.libc, "glibc")
  assert.equal(manifest.binary.file, "opencode")
  assert.deepEqual(manifest.artifacts.map((file) => file.file).sort(), ["LICENSE", "README.md", "source-files.json"])
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
  assert.equal(inventory.dirty, false, "Linux candidates require clean pinned core source")
  const sourceFiles = new Map(inventory.files.map((file) => [file.path, file.sha256]))
  for (const [file, hash] of Object.entries(manifest.inputs.files)) assert.equal(sourceFiles.get(file), hash, `Source input disagrees: ${file}`)
  assert.equal(sourceFiles.get("bun.lock"), manifest.inputs.bunLockSHA256)
  assert.equal(sourceFiles.get("rivloom/models.json"), manifest.inputs.modelsSHA256)
  assert.equal(sourceFiles.get("LICENSE"), manifest.artifacts.find((file) => file.file === "LICENSE").sha256)
  assert.equal(sourceFiles.get("rivloom/README.md"), manifest.artifacts.find((file) => file.file === "README.md").sha256)
  verifyLinuxBinary(path.join(out, "opencode"))
  return manifest
}

export function installedPackageVersion(file) {
  try { return JSON.parse(readFileSync(file, "utf8")).version } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
}
