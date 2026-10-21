// Agent Mem plugin for OpenCode v2 (event stream API).
// Install: `agent-mem setup opencode --write` (copies this file to ~/.config/opencode/plugins/)
// and add the MCP server shown by `agent-mem setup opencode` to opencode.json(c).
// v2 exposes ctx.event.subscribe() as an AsyncIterable of { type, data } events; the v1
// callback signature is accepted but never invoked. Each loaded location gets its own plugin
// instance, so events from other locations are skipped to keep recording single.
// Events are forwarded to `agent-mem hook opencode <event>` as JSON on stdin. Recording is
// fire-and-forget: memory failures never surface.
// v2 limits vs v1: no tool.before DENY and no chat.system/compaction context injection — the
// v2 promise context exposes no pre-tool or system-transform hook. Upgrade to the v2/effect
// format if those are needed.
import { define } from "@opencode-ai/plugin/v2/promise"
import type { Plugin } from "@opencode-ai/plugin/v2/promise"
import { spawn } from "node:child_process"

const TIMEOUT_MS = 2000

function callHook(event: string, payload: Record<string, unknown>): void {
  try {
    const child = spawn("agent-mem", ["hook", "opencode", event], { stdio: ["pipe", "ignore", "ignore"] })
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.on("error", () => clearTimeout(timer))
    child.on("close", () => clearTimeout(timer))
    child.stdin.end(JSON.stringify({ event, ts: Date.now(), ...payload }))
  } catch {
    // never surface memory errors
  }
}

type StreamEvent = { type?: string; data?: Record<string, any> }

const AgentMemPlugin: Plugin = define({
  id: "agent-mem",
  setup(context) {
    const cwd = context.location.directory
    const answer = new Map<string, string>() // accumulated assistant text per session
    const toolName = new Map<string, string>() // tool name per call, from session.tool.input.started
    const toolInput = new Map<string, unknown>() // input per call, from session.tool.called
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          const { type, data } = event as StreamEvent
          if (!type || !data) continue
          const eventCwd = data.location?.directory ?? cwd
          if (eventCwd !== cwd) continue // another plugin instance records this session
          switch (type) {
            case "session.created":
              answer.delete(data.sessionID)
              callHook("session.start", { sessionID: data.sessionID, cwd })
              break
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
  },
})

export default AgentMemPlugin
