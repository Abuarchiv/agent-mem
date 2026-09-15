import type { Plugin } from "@opencode-ai/plugin";

import { createOpenCodePluginHooks } from "./plugin-runtime.js";

/** OpenCode v1 plugins default-export an identified server entry. */
const OpenCodeMemoryPlugin: Plugin = async (input, options) => createOpenCodePluginHooks(input, options);

export default {
  id: "agent-mem",
  server: OpenCodeMemoryPlugin,
};
