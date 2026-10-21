import type { ChildProcess, SpawnOptions } from "node:child_process"
import { isAbsolute } from "node:path"
import type { Duplex } from "node:stream"

const helperKey = "RIVLOOM_MACOS_PROCESS_HELPER"
const socketKey = "RIVLOOM_MACOS_PROCESS_SOCKET"
const controls = new WeakMap<ChildProcess, Duplex>()
type Launch = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess

// Activation comes from the engine host, even when a command deliberately does
// not inherit process.env. The native guard removes both private variables from
// the target environment before exec; ordinary children cannot register guards.
export function guardSpawnPlan(file: string, args: readonly string[], options: SpawnOptions,
  platform: string = process.platform, hostEnv: NodeJS.ProcessEnv = process.env) {
  if (platform !== "darwin") return undefined
  const helper = hostEnv[helperKey], socket = hostEnv[socketKey]
  if (helper === undefined && socket === undefined) return undefined
  if (!helper || !socket || !isAbsolute(helper) || !isAbsolute(socket))
    throw new Error("Incomplete or non-absolute macOS process guard configuration")
  if (!Array.isArray(options.stdio) || options.stdio.length < 3)
    throw new Error("macOS guarded spawn requires explicit standard descriptors")
  if (options.stdio.includes("ipc")) throw new Error("macOS process guard does not support Node IPC descriptors")
  const controlFd = options.stdio.length
  const shell = options.shell
  const target = shell ? (typeof shell === "string" ? shell : "/bin/sh") : file
  const targetArgs = shell ? ["-c", [file, ...args].join(" ")] : [...args]
  return {
    file: helper,
    args: ["guard", "--control-fd", String(controlFd), "--", target, ...targetArgs],
    controlFd,
    options: { ...options, detached: false, shell: false,
      env: { ...(options.env ?? hostEnv), [helperKey]: helper, [socketKey]: socket },
      stdio: [...options.stdio, "pipe"] } as SpawnOptions,
  }
}

export function spawnWithRivloomGuard(file: string, args: readonly string[], options: SpawnOptions, launch: Launch,
  context?: { platform: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const plan = guardSpawnPlan(file, args, options, context?.platform, context?.env)
  if (!plan) return launch(file, args, options)
  const child = launch(plan.file, plan.args, plan.options)
  const control = child.stdio[plan.controlFd]
  if (!control || !("write" in control) || !("end" in control))
    throw new Error("macOS process guard has no private control descriptor")
  const pipe = control as Duplex
  // EOF is itself a cancellation request. A broken control channel never grants
  // permission to signal the cached child PID or its potentially reused group.
  pipe.on("error", () => { pipe.destroy() })
  controls.set(child, pipe)
  return child
}

export function signalRivloomGuard(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const control = controls.get(child)
  if (!control) return false
  if (signal !== "SIGTERM" && signal !== "SIGKILL")
    throw new Error(`Unsupported macOS process guard signal: ${signal}`)
  if (child.exitCode !== null || child.signalCode !== null || control.destroyed || control.writableEnded) return true
  control.write(signal === "SIGTERM" ? "T" : "K")
  return true
}
