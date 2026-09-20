import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { json, publishDirectory, recipeInventory, safeDirectory, sha256, sourceGit, sourceInventory, verifyArtifact, writeChecksums } from "./artifact.mjs"

const recipeRoot = path.dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(path.join(recipeRoot, "runtime.json"), "utf8"))
const args = new Map()
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index]
  assert.ok(["--source", "--output", "--skip-install", "--require-clean"].includes(flag) && !args.has(flag), "Use --source <clean checkout> --output <artifact directory> [--skip-install] [--require-clean]")
  if (["--skip-install", "--require-clean"].includes(flag)) { args.set(flag, true); continue }
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `Missing value for ${flag}`)
  args.set(flag, process.argv[++index])
}
assert.ok(args.has("--source") && args.has("--output"), "An explicit clean --source and --output directory are required")
assert.equal(process.platform, "linux", "Build the Linux candidate on native Linux")
assert.equal(process.arch, "x64", "This profile supports x86-64 only")
assert.ok(process.report.getReport().header.glibcVersionRuntime, "This profile requires glibc, not musl")
assert.equal(process.versions.node, config.nodeVersion)
const root = path.resolve(args.get("--source"))
const output = path.resolve(args.get("--output"))
assert.ok(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(path.basename(output)), "Use a named artifact directory")
assert.ok(root !== output && !root.startsWith(output + path.sep) && recipeRoot !== output && !recipeRoot.startsWith(output + path.sep), "Output cannot contain source or recipe")
safeDirectory(path.dirname(output), output)
safeDirectory(path.join(root, "packages/opencode"), path.join(root, "packages/opencode/dist"))
const source = sourceInventory(root, true)
assert.equal(source.commit, config.source.commit, "Compile the exact reviewed source commit")
assert.equal(source.tree, config.source.tree)
sourceGit(root, "merge-base", "--is-ancestor", config.upstream.commit, "HEAD")
const recipe = recipeInventory(recipeRoot)
for (const [file, hash] of Object.entries(config.inputs)) assert.equal(sha256(path.join(root, file)), hash, `Pinned source input differs: ${file}`)
const packageVersions = Object.fromEntries([["opencode", "packages/opencode/package.json"], ["sdk", "packages/sdk/js/package.json"], ["plugin", "packages/plugin/package.json"]]
  .map(([name, file]) => [name, JSON.parse(readFileSync(path.join(root, file), "utf8")).version]))
for (const value of Object.values(packageVersions)) assert.equal(value, config.upstream.version)
const tools = safeDirectory(path.join(root, "rivloom"), path.join(root, "rivloom/.tools", `linux-bun-${config.bun.version}`))
mkdirSync(tools, { recursive: true })
const archive = path.join(tools, "bun.zip")
if (!existsSync(archive)) {
  const response = await fetch(config.bun.url, { signal: AbortSignal.timeout(180000) })
  assert.equal(response.status, 200, "Pinned Bun download failed")
  const bytes = Buffer.from(await response.arrayBuffer())
  const downloaded = path.join(tools, `download-${randomUUID()}.zip`)
  writeFileSync(downloaded, bytes, { flag: "wx" })
  assert.equal(sha256(downloaded), config.bun.sha256, "Bun download SHA256 mismatch")
  copyFileSync(downloaded, archive, constants.COPYFILE_EXCL)
}
assert.equal(sha256(archive), config.bun.sha256, "Cached Bun archive SHA256 mismatch")
const bun = path.join(tools, "bun")
if (existsSync(bun)) assert.ok(lstatSync(bun).isFile() && !lstatSync(bun).isSymbolicLink(), "Cached Bun must be a regular executable")
// Python's standard library avoids requiring a system package install for unzip.
// Extract exactly one pinned archive member; no archive-supplied path is followed.
const bunArchiveExecutableSHA256 = execFileSync("python3", ["-c", `
import hashlib, os, shutil, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    name = "bun-linux-x64-baseline/bun"
    assert archive.namelist().count(name) == 1, "Ambiguous Bun executable"
    entry = archive.getinfo(name)
    assert (entry.external_attr >> 16) & 0o170000 != 0o120000, "Linked Bun entry"
    digest = hashlib.sha256()
    with archive.open(entry) as stream:
        for chunk in iter(lambda: stream.read(1048576), b""): digest.update(chunk)
    if not os.path.exists(sys.argv[2]):
        with archive.open(entry) as source, open(sys.argv[2], "xb") as target: shutil.copyfileobj(source, target)
    print(digest.hexdigest())
`, archive, bun], { encoding: "utf8", windowsHide: true }).trim()
assert.equal(sha256(bun), bunArchiveExecutableSHA256, "Cached Bun differs from the pinned archive")
chmodSync(bun, 0o755)
assert.equal(execFileSync(bun, ["--version"], { encoding: "utf8", windowsHide: true }).trim(), config.bun.version)
const version = `${config.upstream.version}-rivloom.${source.commit.slice(0, 12)}`
const env = { ...process.env, PATH: `${tools}:${process.env.PATH || ""}`, BUN_INSTALL_CACHE_DIR: path.join(root, "rivloom/.cache/bun"),
  HUSKY: "0", ELECTRON_SKIP_BINARY_DOWNLOAD: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", OPENCODE_VERSION: version,
  OPENCODE_CHANNEL: config.channel, MODELS_DEV_API_JSON: path.join(root, "rivloom/models.json") }
delete env.OPENCODE_RELEASE
delete env.OPENCODE_BUMP
const run = (file, arguments_) => {
  const result = spawnSync(file, arguments_, { cwd: root, env, stdio: "inherit", windowsHide: true })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Failed command: ${file} ${arguments_.join(" ")}`)
}
if (!args.has("--skip-install")) run(bun, ["install", "--frozen-lockfile", "--linker", "hoisted", "--filter", "opencode"])
assert.deepEqual(sourceInventory(root, true), source, "Installing dependencies modified pinned source")
safeDirectory(path.join(root, "packages/opencode"), path.join(root, "packages/opencode/dist"))
run(bun, ["run", "packages/opencode/script/build.ts", "--single", "--baseline", "--skip-install", "--skip-embed-web-ui"])
assert.deepEqual(sourceInventory(root, true), source, "Source changed during compilation")
assert.deepEqual(recipeInventory(recipeRoot), recipe, "Recipe changed during compilation")
const stage = safeDirectory(path.dirname(output), `${output}.stage-${randomUUID()}`)
mkdirSync(stage, { recursive: true })
copyFileSync(path.join(root, "packages/opencode/dist/opencode-linux-x64-baseline/bin/opencode"), path.join(stage, "opencode"))
chmodSync(path.join(stage, "opencode"), 0o755)
copyFileSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"))
copyFileSync(path.join(root, "rivloom/README.md"), path.join(stage, "README.md"))
writeFileSync(path.join(stage, "source-files.json"), json(source))
const record = (file) => ({ file, bytes: readFileSync(path.join(stage, file)).length, sha256: sha256(path.join(stage, file)) })
const manifest = {
  schemaVersion: 2, version, channel: config.channel, target: config.target, builtAt: new Date().toISOString(),
  source: { repository: config.source.repository.replace(/\.git$/, ""), commit: source.commit, tree: source.tree, dirty: false,
    inventory: { file: "source-files.json", sha256: sha256(path.join(stage, "source-files.json")), files: source.files.length } },
  recipe, upstream: config.upstream, packageVersions,
  toolchain: { node: process.versions.node, bun: config.bun.version, bunArchiveSHA256: config.bun.sha256,
    bunExecutableSHA256: sha256(bun), nodeExecutableSHA256: sha256(process.execPath) },
  inputs: { bunLockSHA256: config.inputs["bun.lock"], modelsSHA256: config.inputs["rivloom/models.json"], files: config.inputs },
  profile: config.profile, binary: record("opencode"), artifacts: ["LICENSE", "README.md", "source-files.json"].map(record),
}
writeFileSync(path.join(stage, "runtime-manifest.json"), json(manifest))
verifyArtifact(stage, manifest)
run(process.execPath, [path.join(recipeRoot, "smoke.mjs"), "--source", root, "--artifact", stage])
assert.deepEqual(sourceInventory(root, true), source, "Source changed during smoke verification")
assert.deepEqual(recipeInventory(recipeRoot), recipe, "Recipe changed during smoke verification")
const smoke = JSON.parse(readFileSync(path.join(stage, "smoke-report.json"), "utf8"))
assert.equal(smoke.passed, true)
assert.equal(smoke.checks.length, 11)
assert.equal(smoke.manifestSHA256, sha256(path.join(stage, "runtime-manifest.json")))
assert.equal(smoke.recipeSHA256, recipe.sha256)
writeChecksums(stage)
verifyArtifact(stage, manifest)
publishDirectory(path.dirname(output), stage, output)
console.log(json({ output, manifest, smoke }))
