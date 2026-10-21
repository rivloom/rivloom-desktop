import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFileSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { json, sha256, sourceInventory } from "./artifact.mjs"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
export const portableInventoryDigest = (files) => digest(JSON.stringify([...files]
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, mode, sha256 }) => [path, mode, sha256])))

function regular(root, relative, allowMissing = false) {
  assert.ok(relative && !path.isAbsolute(relative) && !/[\\:\u0000-\u001f]/.test(relative) && relative.split("/").every(part => part && part !== "." && part !== ".."), "Unsafe overlay path")
  let current = path.resolve(root)
  assert.ok(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), "Overlay root must be ordinary")
  for (const part of relative.split("/")) {
    current = path.join(current, part)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    assert.ok(!stat?.isSymbolicLink(), "Overlay path cannot contain links")
    if (!stat) { assert.ok(allowMissing && current === path.resolve(root, relative), "Overlay parent missing"); return current }
  }
  assert.ok(lstatSync(current).isFile(), "Overlay input must be an ordinary file")
  return current
}

export function transformSource(bytes, patch) {
  assert.equal(digest(bytes), patch.beforeSHA256, "Core overlay base bytes differ")
  let text = bytes.toString("utf8")
  for (const edit of patch.edits) {
    assert.ok(typeof edit.before === "string" && edit.before.length > 0 && typeof edit.after === "string")
    assert.equal(text.split(edit.before).length, 2, "Core overlay edit must match exactly once")
    text = text.replace(edit.before, () => edit.after)
  }
  const result = Buffer.from(text)
  assert.equal(digest(result), patch.afterSHA256, "Core overlay result differs")
  return result
}

export function applyMacosSourceOverlay(root, recipeRoot, base) {
  const patchPath = regular(recipeRoot, "core-spawn.patch.json")
  const patch = JSON.parse(readFileSync(patchPath, "utf8"))
  assert.equal(patch.schemaVersion, 1); assert.equal(patch.target, "darwin-arm64"); assert.equal(patch.baseCommit, base.commit)
  assert.deepEqual(patch.files.map(item => item.path), ["packages/core/src/cross-spawn-spawner.ts"])
  assert.deepEqual(patch.additions.map(item => [item.path, item.source]), [["packages/core/src/rivloom-macos-guard.ts", "spawn-guard.ts"]])
  assert.equal(base.dirty, false)
  assert.deepEqual(sourceInventory(root, true), base, "Core overlay requires the exact clean source snapshot")
  const operations = [
    ...patch.files.map(item => {
      const file = regular(root, item.path), original = readFileSync(file)
      assert.equal(base.files.find(entry => entry.path === item.path)?.sha256, item.beforeSHA256)
      return { file, original, bytes: transformSource(original, item) }
    }),
    ...patch.additions.map(item => {
      const file = regular(root, item.path, true), source = regular(recipeRoot, item.source)
      assert.equal(lstatSync(file, { throwIfNoEntry: false }), undefined, "Overlay addition already exists")
      assert.equal(base.files.find(entry => entry.path === item.path), undefined)
      assert.equal(sha256(source), item.sha256, "Overlay module differs from its patch pin")
      return { file, original: null, bytes: readFileSync(source) }
    }),
  ]
  const applied = []
  const restore = () => {
    for (const operation of [...applied].reverse()) {
      regular(root, path.relative(root, operation.file).split(path.sep).join("/"))
      assert.equal(sha256(operation.file), digest(operation.bytes), "Preserving unexpectedly modified overlay input")
      if (operation.original === null) unlinkSync(operation.file)
      else writeFileSync(operation.file, operation.original)
    }
    applied.length = 0
    assert.deepEqual(sourceInventory(root, true), base, "Core overlay restoration differs from clean source")
  }
  try {
    for (const operation of operations) {
      writeFileSync(operation.file, operation.bytes, { flag: operation.original === null ? "wx" : "w" })
      applied.push(operation)
    }
    const compiled = sourceInventory(root)
    assert.equal(compiled.dirty, true)
    const expected = base.files.map(item => {
      const changed = patch.files.find(file => file.path === item.path)
      if (!changed) return item
      return { ...item, sha256: changed.afterSHA256, bytes: operations.find(op => op.file === path.join(root, item.path)).bytes.length }
    })
    for (const item of patch.additions) expected.push({ path: item.path, mode: "100644", tracked: false, type: "file", bytes: readFileSync(path.join(root, item.path)).length, sha256: item.sha256 })
    expected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    assert.deepEqual(compiled.files, expected, "Unreviewed source change during overlay application")
    const receipt = { schemaVersion: 1, kind: "rivloom-macos-source-overlay", baseCommit: base.commit, baseTree: base.tree,
      baseInventorySHA256: portableInventoryDigest(base.files), compiledInventorySHA256: portableInventoryDigest(compiled.files),
      patch: { file: "macos-core-spawn.patch.json", sha256: sha256(patchPath) },
      files: patch.files.map(item => ({ path: item.path, beforeSHA256: item.beforeSHA256, afterSHA256: item.afterSHA256, artifact: "macos-cross-spawn-spawner.ts" })),
      additions: patch.additions.map(item => ({ path: item.path, sha256: item.sha256, artifact: "macos-spawn-guard.ts" })) }
    return { compiled, receipt, restore,
      verify: () => assert.deepEqual(sourceInventory(root), compiled, "Compiled source changed outside the exact macOS overlay"),
      package: (stage) => {
        writeFileSync(path.join(stage, "compiled-source-files.json"), json(compiled))
        writeFileSync(path.join(stage, "macos-source-overlay.json"), json(receipt))
        copyFileSync(patchPath, path.join(stage, "macos-core-spawn.patch.json"))
        copyFileSync(regular(root, patch.files[0].path), path.join(stage, "macos-cross-spawn-spawner.ts"))
        copyFileSync(regular(root, patch.additions[0].path), path.join(stage, "macos-spawn-guard.ts"))
      },
    }
  } catch (error) { restore(); throw error }
}
