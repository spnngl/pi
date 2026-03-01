/**
 * Frontmatter Context Loader Extension
 *
 * Intercepts prompts with YAML frontmatter, loads INSTRUCTIONS.md files
 * from ~/.pi/<path>/, and injects content before LLM processing.
 *
 * Format:
 * ---
 * docs: lang/nu, lang/python
 * ---
 * Your prompt here
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const BASE_DIR = path.join(os.homedir(), ".pi");
const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

interface LoadResult {
  path: string;
  fullPath: string;
  content: string | null;
  size: number;
}

function parseFrontmatter(prompt: string): { docs: string[]; body: string } | null {
  const match = prompt.match(FRONTMATTER_REGEX);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2];

  const docs: string[] = [];
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (key === "docs" && value) {
      const paths = value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      docs.push(...paths);
    }
  }

  return { docs, body };
}

function loadDoc(docPath: string): LoadResult {
  const fullPath = path.join(BASE_DIR, docPath, INSTRUCTIONS_FILE);

  if (!fs.existsSync(fullPath)) {
    return { path: docPath, fullPath, content: null, size: 0 };
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  return { path: docPath, fullPath, content, size: content.length };
}

function formatContent(results: LoadResult[]): string {
  const sections: string[] = [];

  for (const result of results) {
    if (result.content === null) continue;
    sections.push(
      `<!-- docs: ${result.path} -->\n${result.content}\n<!-- /docs: ${result.path} -->`,
    );
  }

  return sections.join("\n\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt ?? "";

    // Fast bail-out
    if (!prompt.startsWith("---\n")) return;

    const parsed = parseFrontmatter(prompt);
    if (!parsed || parsed.docs.length === 0) {
      // Has frontmatter but no docs key - just strip frontmatter
      if (parsed) {
        return { prompt: parsed.body.trim() };
      }
      return;
    }

    const results: LoadResult[] = [];
    for (const docPath of parsed.docs) {
      const result = loadDoc(docPath);
      results.push(result);

      if (result.content !== null) {
        ctx.ui.notify(`✓ ${docPath} (${formatSize(result.size)})`, "info");
      } else {
        ctx.ui.notify(`✗ ${docPath} → not found`, "warning");
      }
    }

    const loadedResults = results.filter((r) => r.content !== null);
    if (loadedResults.length === 0) {
      return { prompt: parsed.body.trim() };
    }

    const injectedContent = formatContent(loadedResults);

    return {
      message: {
        customType: "frontmatter-docs",
        content: injectedContent,
        display: false,
      },
      prompt: parsed.body.trim(),
    };
  });

  pi.registerCommand("frontmatter-test", {
    description: "Test frontmatter doc loading without sending to LLM",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /frontmatter-test docs: path1, path2", "warning");
        return;
      }

      // Parse as if it were frontmatter content
      const docs = args
        .replace(/^docs:\s*/i, "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      if (docs.length === 0) {
        ctx.ui.notify("No paths specified", "warning");
        return;
      }

      console.log("\n=== Frontmatter Test ===\n");

      for (const docPath of docs) {
        const result = loadDoc(docPath);
        if (result.content !== null) {
          console.log(`✓ ${docPath} → ${result.fullPath} (${formatSize(result.size)})`);
        } else {
          console.log(`✗ ${docPath} → ${result.fullPath} (not found)`);
        }
      }

      console.log("\n========================\n");
    },
  });
}
