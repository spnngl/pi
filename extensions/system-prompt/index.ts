/**
 * System Prompt Extension - Print the current system prompt
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register a tool that the LLM can call to get the system prompt
  pi.registerTool({
    name: "print_system_prompt",
    label: "Print System Prompt",
    description: "Print the current system prompt that defines the assistant's behavior",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const systemPrompt = ctx.getSystemPrompt();

      return {
        content: [{ type: "text", text: systemPrompt }],
        details: { length: systemPrompt.length },
      };
    },
  });

  // Register a command for quick access without going through LLM
  pi.registerCommand("system-prompt", {
    description: "Display the current system prompt",
    handler: async (_args, ctx) => {
      const systemPrompt = ctx.getSystemPrompt();
      ctx.ui.notify(`System prompt (${systemPrompt.length} chars) - check terminal output`, "info");
      console.log("\n=== SYSTEM PROMPT ===\n");
      console.log(systemPrompt);
      console.log("\n=== END SYSTEM PROMPT ===\n");
    },
  });
}
