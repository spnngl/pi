/**
 * Git Clone Extension
 *
 * Provides a `git_clone` tool that the LLM can call to clone repositories
 * into ~/src/<registry>/<path>/<name>. If the repository already exists,
 * runs `git pull` instead.
 *
 * Authentication is handled externally (ssh-agent, credential helper, etc.).
 *
 * Supported URL formats:
 *   git@gitlab.wiremind.io:wiremind/devops/repo.git  (SSH)
 *   https://github.com/user/repo.git                 (HTTPS)
 *   git://github.com/user/repo.git                   (Git protocol)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// URL parser
// ---------------------------------------------------------------------------

interface ParsedRepo {
  /** Hostname of the git registry, e.g. "github.com" or "gitlab.wiremind.io" */
  registry: string;
  /**
   * All path segments including the repo name, e.g.
   * ["user", "repo"] or ["wiremind", "devops", "wiremind-services-configuration"]
   */
  segments: string[];
  /** Last segment — the repository name, e.g. "repo" */
  name: string;
  /** Original URL, preserved for the git clone command */
  cloneUrl: string;
}

/**
 * Parse a git URL into its constituent parts.
 * Returns null for unrecognised or malformed inputs.
 */
function parseGitUrl(input: string): ParsedRepo | null {
  const raw = input.trim();

  // SSH: git@host:path[.git]
  const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const registry = sshMatch[1];
    const repoPath = sshMatch[2];
    const segments = repoPath.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    return {
      registry,
      segments,
      name: segments[segments.length - 1],
      cloneUrl: raw,
    };
  }

  // HTTPS or git:// — use the URL constructor for reliable parsing.
  // Node.js accepts the "git:" scheme, so this works for both.
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:" &&
      url.protocol !== "git:"
    ) {
      return null;
    }
    const registry = url.hostname;
    // Strip leading slash and optional .git suffix, then split.
    const segments = url.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (segments.length === 0) return null;
    return {
      registry,
      segments,
      name: segments[segments.length - 1],
      cloneUrl: raw,
    };
  } catch {
    return null;
  }
}

/**
 * Compute the absolute local path for a parsed repo:
 * ~/src/<registry>/<...segments>
 */
function localPath(parsed: ParsedRepo): string {
  return path.join(os.homedir(), "src", parsed.registry, ...parsed.segments);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function gitCloneExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_clone",
    label: "Git Clone",
    description: `\
Clone a git repository into ~/src/<registry>/<path>/<name>.
If the target directory already exists, runs \`git pull\` instead.
Authentication is handled by the user's environment (ssh-agent, credential helper, etc.).

Supported URL formats:
  git@gitlab.wiremind.io:wiremind/devops/repo.git  (SSH, preferred)
  https://github.com/user/repo.git                 (HTTPS)
  git://github.com/user/repo.git                   (Git protocol)

Examples:
  git@github.com:user/repo.git
    → ~/src/github.com/user/repo
  git@gitlab.wiremind.io:wiremind/devops/wiremind-services-configuration.git
    → ~/src/gitlab.wiremind.io/wiremind/devops/wiremind-services-configuration`,

    parameters: Type.Object({
      url: Type.String({
        description:
          "Git repository URL (e.g. 'git@github.com:user/repo.git', 'https://github.com/user/repo.git')",
      }),
      branch: Type.Optional(
        Type.String({
          description:
            "Branch or tag to checkout. Defaults to the repository's default branch.",
        }),
      ),
      shallow: Type.Optional(
        Type.Boolean({
          description:
            "Perform a shallow clone (--depth 1). Faster but omits full history.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      // 1. Parse the URL.
      const parsed = parseGitUrl(params.url);
      if (!parsed) {
        return {
          content: [
            {
              type: "text",
              text: [
                `Invalid git URL: "${params.url}"`,
                "Expected formats:",
                "  git@host:path.git  (SSH)",
                "  https://host/path.git  (HTTPS)",
                "  git://host/path.git  (Git protocol)",
              ].join("\n"),
            },
          ],
          details: {},
          isError: true,
        };
      }

      // 2. Compute target path.
      const target = localPath(parsed);
      const exists = fs.existsSync(target);

      // 3a. If it already exists, pull.
      if (exists) {
        onUpdate?.({
          content: [
            { type: "text", text: `Already cloned — pulling ${target} ...` },
          ],
          details: {},
        });

        const result = await pi.exec("git", ["-C", target, "pull"], { signal });

        if (result.killed) {
          return {
            content: [{ type: "text", text: "git pull was cancelled." }],
            details: { path: target },
            isError: true,
          };
        }

        if (result.code !== 0) {
          return {
            content: [
              {
                type: "text",
                text: `git pull failed (exit ${result.code}):\n${result.stderr || result.stdout}`.trim(),
              },
            ],
            details: { path: target },
            isError: true,
          };
        }

        const output = (result.stdout || "Already up to date.").trim();
        return {
          content: [{ type: "text", text: `Pulled: ${target}\n${output}` }],
          details: { path: target, action: "pull" as const },
          isError: false,
        };
      }

      // 3b. Otherwise, clone.
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true });

      onUpdate?.({
        content: [
          { type: "text", text: `Cloning ${params.url} → ${target} ...` },
        ],
        details: {},
      });

      const args: string[] = ["clone"];
      if (params.branch) args.push("--branch", params.branch);
      if (params.shallow) args.push("--depth", "1");
      args.push(params.url, target);

      const result = await pi.exec("git", args, { signal });

      if (result.killed) {
        return {
          content: [{ type: "text", text: "git clone was cancelled." }],
          details: {},
          isError: true,
        };
      }

      if (result.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `git clone failed (exit ${result.code}):\n${result.stderr || result.stdout}`.trim(),
            },
          ],
          details: {},
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: `Cloned: ${target}` }],
        details: { path: target, action: "clone" as const },
        isError: false,
      };
    },
  });
}
