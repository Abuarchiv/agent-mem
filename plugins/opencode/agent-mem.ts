// Agent Mem plugin for OpenCode 2 (event stream, `setup`) and OpenCode 1.x (hooks, `server`).
// Install: `agent-mem setup opencode --write` (copies this file to ~/.config/opencode/plugins/)
// and add the MCP server shown by `agent-mem setup opencode` to opencode.json(c).
// OpenCode 2 calls `setup` and streams { type, data } events; each loaded location gets its own
// plugin instance, so events from other locations are skipped to keep recording single.
// OpenCode 1.x (the npm package) loads only a default export with `server()` and calls its hooks.
// Events are forwarded to `agent-mem hook opencode <event>` as JSON on stdin; memory failures
// never surface. OpenCode 2's promise context has no pre-tool or system-transform hook: there
// agent-mem records only, 1.x also gets context and the deny of an enabled rule.
// Types only: a fresh OpenCode 2 has no @opencode-ai/plugin package next to this file, and a runtime import of it
// made the plugin fail to load.
import type { Plugin, PluginContext } from "@opencode-ai/plugin/v2/promise"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"

const define = (plugin: Plugin): Plugin => plugin // what @opencode-ai/plugin's define() does

const TIMEOUT_MS = 2000

// Hooks run one after another: a session.start child must have written its row before the
// chat.message child looks the session up, and both are separate processes.
let queue: Promise<void> = Promise.resolve()

function callHook(event: string, payload: Record<string, unknown>): void {
  queue = queue.then(
    () =>
      new Promise<void>((resolve) => {
        try {
          const child = spawn("agent-mem", ["hook", "opencode", event], { stdio: ["pipe", "ignore", "ignore"] })
          const done = () => {
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(() => {
            child.kill()
            resolve()
          }, TIMEOUT_MS)
          child.on("error", done)
          child.on("close", done)
          // stdout is ignored: agent-mem then records without building context nobody reads.
          child.stdin.end(JSON.stringify({ event, ts: Date.now(), reads_context: false, ...payload }))
        } catch {
          resolve() // never surface memory errors
        }
      }),
  )
}

type HookResult = { context?: string | null; deny?: string | null }

// OpenCode 1.x waits for the hook and reads its answer: context for the next model call or a deny.
function askHook(event: string, payload: Record<string, unknown>): Promise<HookResult> {
  return new Promise((resolve) => {
    let out = ""
    let done = false
    const finish = (value: HookResult) => {
      if (!done) {
        done = true
        resolve(value)
      }
    }
    try {
      const child = spawn("agent-mem", ["hook", "opencode", event], { stdio: ["pipe", "pipe", "ignore"] })
      const timer = setTimeout(() => {
        child.kill()
        finish({})
      }, TIMEOUT_MS)
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => (out += chunk))
      child.on("error", () => finish({}))
      child.on("close", () => {
        clearTimeout(timer)
        try {
          finish(out.trim() ? (JSON.parse(out) as HookResult) : {})
        } catch {
          finish({})
        }
      })
      child.stdin.end(JSON.stringify({ event, ts: Date.now(), ...payload }))
    } catch {
      finish({})
    }
  })
}

function promptText(parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
}

const isOwnTool = (tool: string) => tool.includes("agent-mem") || tool.startsWith("mem_")

async function server({ directory }: PluginInput): Promise<Hooks> {
  const pending = new Map<string, string>() // context for the next model call, per session
  const lastAnswer = new Map<string, string>() // final assistant text of the current turn
  const queue = (sessionID: string, result: HookResult) => {
    if (result.context) pending.set(sessionID, result.context)
  }
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const id = event.properties.info.id
        queue(id, await askHook("session.start", { sessionID: id, cwd: directory }))
      } else if (event.type === "session.idle") {
        const id = event.properties.sessionID
        await askHook("session.idle", { sessionID: id, cwd: directory, answer: lastAnswer.get(id) })
        lastAnswer.delete(id)
      }
    },
    "chat.message": async (input, output) => {
      const prompt = promptText(output.parts)
      if (!prompt) return
      lastAnswer.delete(input.sessionID)
      queue(input.sessionID, await askHook("chat.message", { sessionID: input.sessionID, cwd: directory, prompt }))
    },
    "experimental.text.complete": async (input, output) => {
      lastAnswer.set(input.sessionID, output.text)
    },
    "experimental.chat.system.transform": async (input, output) => {
      const context = input.sessionID ? pending.get(input.sessionID) : undefined
      if (context && input.sessionID) {
        output.system.push(context)
        pending.delete(input.sessionID)
      }
    },
    // Session goal, decisions and open problems go into the compaction prompt so they survive it.
    "experimental.session.compacting": async (input, output) => {
      const result = await askHook("session.compacting", { sessionID: input.sessionID, cwd: directory })
      if (result.context) output.context.push(result.context)
    },
    "tool.execute.before": async (input, output) => {
      if (isOwnTool(input.tool)) return
      const result = await askHook("tool.before", {
        sessionID: input.sessionID,
        cwd: directory,
        tool: input.tool,
        callID: input.callID,
        args: output.args,
      })
      if (result.deny) throw new Error(result.deny)
      queue(input.sessionID, result)
    },
    "tool.execute.after": async (input, output) => {
      if (isOwnTool(input.tool)) return
      const result = await askHook("tool.after", {
        sessionID: input.sessionID,
        cwd: directory,
        tool: input.tool,
        callID: input.callID,
        args: input.args,
        output: output.output,
        exit: output.metadata?.exit,
      })
      queue(input.sessionID, result)
    },
  }
}

type StreamEvent = { type?: string; data?: Record<string, any> }

// OpenCode passes these as well and calls the returned cleanup; @opencode-ai/plugin 1.19 declares neither.
type Runtime = {
  location: { directory: string }
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> }
}

const AgentMemPlugin: Plugin = define({
  id: "agent-mem",
  setup: ((context: PluginContext & Runtime) => {
    const cwd = context.location.directory
    const started = new Set<string>() // sessions this instance has announced to agent-mem
    const answer = new Map<string, string>() // accumulated assistant text per session
    const toolName = new Map<string, string>() // tool name per call, from session.tool.input.started
    const toolInput = new Map<string, unknown>() // input per call, from session.tool.called
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          const { type, data } = event as StreamEvent
          if (!type || !data?.sessionID) continue
          if ((data.location?.directory ?? cwd) !== cwd) continue // another plugin instance records this session
          if (!started.has(data.sessionID)) {
            // session.created can race plugin setup, so the first event of a session starts it.
            started.add(data.sessionID)
            callHook("session.start", { sessionID: data.sessionID, cwd })
          }
          switch (type) {
            case "session.inbox.enqueued":
              if (data.item?.type === "user") {
                answer.set(data.sessionID, "") // new turn resets the accumulated answer
                callHook("chat.message", {
                  sessionID: data.sessionID,
                  cwd,
                  prompt: data.item.payload?.text ?? "",
                })
              }
              break
            case "session.tool.input.started":
              toolName.set(data.id, data.name)
              break
            case "session.tool.called":
              toolInput.set(data.id, data.input)
              break
            case "session.tool.success":
            case "session.tool.failed": {
              const name = toolName.get(data.id)
              const args = toolInput.get(data.id)
              toolName.delete(data.id)
              toolInput.delete(data.id)
              if (!name) break
              callHook("tool.after", {
                sessionID: data.sessionID,
                cwd,
                tool: name,
                callID: data.id,
                args,
                output: data.content,
                exit: type === "session.tool.failed" ? 1 : 0,
              })
              break
            }
            case "session.text.ended":
              answer.set(data.sessionID, (answer.get(data.sessionID) ?? "") + (data.text ?? ""))
              break
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
              callHook("session.idle", { sessionID: data.sessionID, cwd, answer: answer.get(data.sessionID) })
              answer.delete(data.sessionID)
              break
          }
        }
      } catch {
        // the stream aborts when the plugin unloads
      }
    })()

    return () => controller.abort()
  }) as unknown as Plugin["setup"],
})

export default { ...AgentMemPlugin, server }
