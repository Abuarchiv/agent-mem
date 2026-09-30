// Agent Mem plugin for OpenCode (typed against @opencode-ai/plugin 1.18).
// Install: `agent-mem setup opencode --write` (copies this file to ~/.config/opencode/plugins/)
// and add the MCP server shown by `agent-mem setup opencode` to opencode.json.
//
// Events are forwarded to `agent-mem hook opencode <event>` as JSON on stdin. Memory failures
// never surface; the only intentional throw is an enabled rule that blocks a command.
import type { Plugin } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"

const TIMEOUT_MS = 2000

type HookResult = { context?: string | null; deny?: string | null }

function callHook(event: string, payload: Record<string, unknown>): Promise<HookResult> {
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

export const AgentMem: Plugin = async ({ directory }) => {
  const pending = new Map<string, string>() // context for the next model call, per session
  const lastAnswer = new Map<string, string>() // final assistant text of the current turn

  const queue = (sessionID: string, result: HookResult) => {
    if (result.context) pending.set(sessionID, result.context)
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const id = event.properties.info.id
        queue(id, await callHook("session.start", { sessionID: id, cwd: directory }))
      } else if (event.type === "session.idle") {
        const id = event.properties.sessionID
        await callHook("session.idle", { sessionID: id, cwd: directory, answer: lastAnswer.get(id) })
        lastAnswer.delete(id)
      }
    },

    "chat.message": async (input, output) => {
      const prompt = promptText(output.parts)
      if (!prompt) return
      lastAnswer.delete(input.sessionID)
      queue(input.sessionID, await callHook("chat.message", { sessionID: input.sessionID, cwd: directory, prompt }))
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
      const result = await callHook("session.compacting", { sessionID: input.sessionID, cwd: directory })
      if (result.context) output.context.push(result.context)
    },

    "tool.execute.before": async (input, output) => {
      if (isOwnTool(input.tool)) return
      const result = await callHook("tool.before", {
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
      const result = await callHook("tool.after", {
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

export default AgentMem
