/**
 * Frontmatter Context Loader Extension
 *
 * Intercepts prompts with YAML frontmatter, loads INSTRUCTIONS.md files
 * from ~/.pi/<key>/<path>/, and injects content before LLM processing.
 *
 * Format:
 * ---
 * docs: lang/nu, lang/python
 * config: myapp
 * ---
 * Your prompt here
 *
 * Translates to:
 * - ~/.pi/docs/lang/nu/INSTRUCTIONS.md
 * - ~/.pi/docs/lang/python/INSTRUCTIONS.md
 * - ~/.pi/config/myapp/INSTRUCTIONS.md
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

function parseFrontmatter(prompt: string): { paths: string[]; body: string } | null {
  const match = prompt.match(FRONTMATTER_REGEX);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2];

  const paths: string[] = [];
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key && value) {
      // key: subpath1, subpath2 → key/subpath1, key/subpath2
      const subpaths = value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      for (const subpath of subpaths) {
        paths.push(`${key}/${subpath}`);
      }
    }
  }

  return { paths, body };
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
    if (!parsed || parsed.paths.length === 0) {
      // Has frontmatter but no docs key - just strip frontmatter
      if (parsed) {
        return { prompt: parsed.body.trim() };
      }
      return;
    }

    const results: LoadResult[] = [];
    for (const docPath of parsed.paths) {
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
        ctx.ui.notify("Usage: /frontmatter-test key: path1, path2", "warning");
        return;
      }

      // Parse as frontmatter line: key: value1, value2
      const colonIndex = args.indexOf(":");
      if (colonIndex === -1) {
        ctx.ui.notify("Format: key: path1, path2", "warning");
        return;
      }

      const key = args.slice(0, colonIndex).trim();
      const value = args.slice(colonIndex + 1).trim();

      if (!key || !value) {
        ctx.ui.notify("Format: key: path1, path2", "warning");
        return;
      }

      const paths = value
        .split(",")
        .map((p) => `${key}/${p.trim()}`)
        .filter((p) => p !== `${key}/`);

      if (paths.length === 0) {
        ctx.ui.notify("No paths specified", "warning");
        return;
      }

      console.log("\n=== Frontmatter Test ===\n");

      for (const docPath of paths) {
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
