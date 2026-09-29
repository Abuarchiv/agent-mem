// Agent Mem plugin for OpenCode.
// Install: `agent-mem setup opencode --write` (copies this file to ~/.config/opencode/plugin/)
// and add the MCP server shown by `agent-mem setup opencode` to opencode.json.
//
// The plugin forwards OpenCode events to `agent-mem hook opencode <event>` as JSON on stdin.
// It never throws on memory failures; the only intentional throw is a learned rule that
// blocks a command (tool.execute.before), which OpenCode shows to the agent.
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
      child.stdout.on("data", (chunk) => (out += chunk.toString()))
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

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p: any) => p.text)
    .join("\n")
}

export const AgentMem: Plugin = async ({ directory }) => {
  const pending = new Map<string, string>() // context to inject on the next model call, per session
  const lastAnswer = new Map<string, string>()

  const queue = (sessionID: string, result: HookResult) => {
    if (result.context) pending.set(sessionID, result.context)
  }

  return {
    event: async ({ event }: any) => {
      const props = event?.properties ?? {}
      if (event?.type === "session.created" && props.info?.id) {
        queue(props.info.id, await callHook("session.start", { sessionID: props.info.id, cwd: directory }))
      } else if (event?.type === "session.idle" && props.sessionID) {
        await callHook("session.idle", { sessionID: props.sessionID, cwd: directory, answer: lastAnswer.get(props.sessionID) })
        lastAnswer.delete(props.sessionID)
      } else if (event?.type === "session.compacted" && props.sessionID) {
        await callHook("session.compacting", { sessionID: props.sessionID, cwd: directory })
        queue(props.sessionID, await callHook("session.start", { sessionID: props.sessionID, cwd: directory, source: "compact" }))
      } else if (event?.type === "message.part.updated") {
        const part = props.part
        if (part?.type === "text" && typeof part.text === "string" && part.sessionID && !part.synthetic) {
          lastAnswer.set(part.sessionID, part.text)
        }
      }
    },

    "chat.message": async (input: any, output: any) => {
      const prompt = textOf(output?.parts)
      if (!prompt || !input?.sessionID) return
      lastAnswer.delete(input.sessionID)
      queue(input.sessionID, await callHook("chat.message", { sessionID: input.sessionID, cwd: directory, prompt }))
    },

    "experimental.chat.system.transform": async (input: any, output: any) => {
      const sessionID = input?.sessionID
      const context = sessionID ? pending.get(sessionID) : undefined
      if (context && Array.isArray(output?.system)) {
        output.system.push(context)
        pending.delete(sessionID)
      }
    },

    "tool.execute.before": async (input: any, output: any) => {
      if (!input?.sessionID || String(input.tool).includes("agent-mem")) return
      const result = await callHook("tool.before", {
        sessionID: input.sessionID,
        cwd: directory,
        tool: input.tool,
        callID: input.callID,
        args: output?.args,
      })
      if (result.deny) throw new Error(result.deny)
      queue(input.sessionID, result)
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!input?.sessionID || String(input.tool).includes("agent-mem")) return
      const result = await callHook("tool.after", {
        sessionID: input.sessionID,
        cwd: directory,
        tool: input.tool,
        callID: input.callID,
        args: input.args,
        output: output?.output,
        exit: output?.metadata?.exit,
      })
      queue(input.sessionID, result)
    },
  }
}

export default AgentMem
