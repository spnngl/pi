/**
 * Nushell Extension for Pi — replaces the built-in bash tool.
 *
 * Nushell can run every external CLI (git, npm, docker, curl, rg, …) AND
 * provides structured-data pipelines that replace bash + python/pandas.
 *
 * The tool description is derived from nushell's own MCP integration
 * (crates/nu-mcp/src/instructions.md and evaluate_tool.md) and the
 * official style guide (https://www.nushell.sh/book/style_guide.html).
 *
 * Usage:
 *   pi -e ./extensions/nushell
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  TruncationResult,
} from "@mariozechner/pi-coding-agent";
import {
  truncateTail,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nushellSchema = Type.Object({
  command: Type.String({
    description: "Nushell command to execute in the current working directory",
  }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout)",
    }),
  ),
});

interface NushellToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), "pi-nushell-" + id + ".log");
}

/**
 * Kill a process and its entire group.
 * On UNIX `spawn` is called with `detached: true` so the child gets its own
 * process group.  Sending SIGKILL to the negative PID kills the whole group.
 */
function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group kill failed (e.g. process already dead) — try direct kill as fallback
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already dead — nothing to do
    }
  }
}

const TOOL_DESCRIPTION = [
  "Execute a Nushell command in the current working directory.",
  "Returns stdout and stderr.",
  "Output is truncated to last " +
    DEFAULT_MAX_LINES +
    " lines or " +
    DEFAULT_MAX_BYTES / 1024 +
    "KB (whichever is hit first).",
  "If truncated, full output is saved to a temp file.",
  "Optionally provide a timeout in seconds.",
  "",
  "Nushell replaces bash. It runs every external CLI (git, npm, docker, rg,",
  "make, cargo, kubectl, …) AND provides structured-data pipelines that",
  "replace python/pandas for data work.",
  "Prefer nushell native commands where possible as they provide structured",
  "data in a pipeline versus text output.",
  "",
  "Avoid commands that produce very large output; consider piping to files.",
  "For long-lived commands, background them: `job spawn { uvicorn main:app }`",
  "",
  "BASH-TO-NUSHELL COMMAND EQUIVALENTS:",
  "  mkdir -p path       -> mkdir path",
  "  > file              -> o> file",
  "  >> file             -> o>> file",
  "  > /dev/null         -> ignore",
  "  > /dev/null 2>&1    -> o+e>| ignore",
  "  cmd 2>&1            -> cmd o+e>| ...",
  "  cmd | tee log | cmd2 -> cmd | tee { save log } | cmd2",
  "  cmd | head -5       -> cmd | first 5",
  "  cat path            -> open --raw path",
  "  cp src dest         -> cp src dest",
  "  rm -rf path         -> rm -r path",
  "  sed                 -> str replace",
  "  grep pattern        -> where $it =~ pattern  OR  find pattern",
  "  cmd1 && cmd2        -> cmd1; cmd2",
  "  echo $PATH          -> $env.PATH",
  "  echo $?             -> $env.LAST_EXIT_CODE",
  "  export              -> $env",
  "  FOO=BAR ./bin       -> FOO=BAR ./bin",
  "  echo $FOO           -> $env.FOO",
  '  echo ${FOO:-fb}     -> $env.FOO? | default "fb"',
  "  stat $(which git)   -> stat ...(which git).path",
  '  echo /tmp/$RANDOM   -> $"/tmp/(random int)"',
  '  cargo b --jobs=$(nproc) -> cargo b $"--jobs=(sys cpu | length)"',
  "  for f in *.md; do echo $f; done -> ls *.md | each { $in.name }",
  "  for i in $(seq 1 10); do echo $i; done -> for i in 1..10 { print $i }",
  "",
  "CRITICAL SYNTAX RULES:",
  "  - Chain commands with `;` — NOT `&&` or `||`",
  '  - String interpolation: $"hello ($name)" — NOT $name or ${name}',
  '    Variables/expressions MUST be in parentheses inside $"..."',
  "  - Variables: let x = 42; $x — NOT x=42",
  "  - Env vars: $env.HOME — NOT $HOME",
  "  - Command substitution: (git status) — NOT $(git status)",
  "  - Conditionals: if COND { ... } else { ... }",
  "  - Redirect stderr: cmd o+e>| other — NOT cmd 2>&1",
  "  - ANSI strip: output | ansi strip — NOT \\u001b regex",
  "  - Special chars: use `char escape`, `char newline`, `char tab`",
  "",
  "STRING TYPES:",
  "  'single'    -> literal, no escapes, good for paths: 'C:\\path'",
  '  "double"    -> C-style escapes: "line1\\nline2"',
  '  $"interp"   -> interpolation: $"hello ($var)"',
  "  r#'raw'#    -> no escaping needed, can contain any quotes",
  "  `backtick`  -> paths with spaces or globs: `./my dir`",
  "",
  "FLAGS WITH VARIABLES: the entire flag must be an interpolated string:",
  '  GOOD: curl -H $"Authorization: Bearer ($token)"',
  '  BAD:  curl -H "Authorization: Bearer $token"',
  "",
  "SHADOWED COMMANDS — nushell built-ins that replace system binaries:",
  "  ls, cp, mv, rm, mkdir, sort, echo, which, find, ps, du, open, date, sleep",
  "  Use ^ prefix to call the system version: ^find, ^sort, ^ls",
  "  nushell `find` searches text — use `glob **/*.ext` or `^find` for files",
  "  nushell `open` auto-parses CSV/JSON/TOML/YAML/XLSX into structured data",
  "  nushell `sort` works on tables — use `^sort` for line-based sort",
  "",
  "STRUCTURED DATA:",
  "  open file.csv                -> auto-parse to table",
  "  open file.json               -> auto-parse to record",
  "  from json / from csv / from toml / from yaml -> parse piped text",
  "  to json / to csv / to md / to yaml -> convert output",
  "  where COL OP VAL             -> filter rows",
  "  select COL1 COL2             -> pick columns",
  "  reject COL                   -> drop columns",
  "  get FIELD                    -> extract a field from record",
  "  sort-by COL --reverse        -> sort rows",
  "  group-by COL                 -> group rows",
  "  uniq-by COL                  -> deduplicate",
  "  each { |row| ... }           -> map over rows",
  "  par-each { |row| ... }       -> parallel map (faster for I/O work)",
  "  reduce { |acc, it| ... }     -> fold",
  "  math sum / math avg / math min / math max -> aggregation",
  "  length                       -> count rows",
  "  first N / last N / skip N    -> slice",
  "  columns                      -> list column names",
  "  describe                     -> inspect types",
  "  transpose                    -> pivot rows/columns",
  "  lines                        -> split text into list of strings",
  "  str contains / str replace / str trim -> string ops",
  "  try { ... } catch { |e| ... } -> error handling",
  "",
  "HTTP:",
  "  http get URL                 -> GET request",
  "  http post --content-type application/json URL { body } -> POST",
  '  http post URL -H {X-API-Key: "secret"} { body }       -> POST with headers',
  "  http put URL body / http delete URL / http patch URL body",
  "",
  "BACKGROUND JOBS:",
  "  job spawn { long-command }   -> run in background (like bash &)",
  '  job spawn --tag "desc" { cmd } -> with description',
  "  job list                     -> list running jobs",
  "  job kill ID                  -> terminate a job",
  "  job spawn { cmd | job send 0 }; job recv -> get output from bg job",
  "",
  "WRITING .NU SCRIPTS — quality tooling:",
  "  nu --ide-check 10 file.nu   -> parse errors as JSON diagnostics",
  "  nu-lint file.nu             -> lint with 150+ rules (idioms, dead code,",
  "                                 POSIX patterns, performance, type safety)",
  "  nu-lint --fix file.nu       -> auto-fix lint violations",
  "  nufmt file.nu               -> format in place (AST-based, official)",
  "  nufmt --stdin < file.nu     -> format to stdout",
  "  nufmt --dry-run file.nu     -> check if formatting needed (exit 1 if so)",
  "  Prefer `nu-lint` — it catches idioms (echo->value, cat->open, grep->find,",
  "  head->first), dead code, missing types, and runtime error patterns.",
  "  Run `nu-lint --fix` then `nufmt` for clean idiomatic nushell.",
].join("\n");

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bash",
    label: "Nu",
    description: TOOL_DESCRIPTION,
    parameters: nushellSchema,
    execute: (
      _toolCallId: string,
      params: { command: string; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<NushellToolDetails> | undefined,
      ctx: ExtensionContext,
    ) => {
      const command = params.command;
      const timeout = params.timeout;
      const cwd = ctx.cwd;

      type Result = AgentToolResult<NushellToolDetails>;

      if (!existsSync(cwd)) {
        return Promise.reject<Result>(
          new Error(
            "Working directory does not exist: " +
              cwd +
              "\n" +
              "Cannot execute nushell commands.",
          ),
        );
      }

      return new Promise<Result>((resolve, reject) => {
        const child = spawn("nu", ["-c", command], {
          cwd,
          detached: true,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              killProcessTree(child.pid);
            }
          }, timeout * 1000);
        }

        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;

        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFilePath();
            tempFileStream = createWriteStream(tempFilePath);
            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          if (tempFileStream) {
            tempFileStream.write(data);
          }

          chunks.push(data);
          chunksBytes += data.length;

          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift();
            if (removed) {
              chunksBytes -= removed.length;
            }
          }

          if (onUpdate) {
            const buf = Buffer.concat(chunks);
            const text = buf.toString("utf-8");
            const trunc = truncateTail(text);
            onUpdate({
              content: [{ type: "text", text: trunc.content || "" }],
              details: {
                truncation: trunc.truncated ? trunc : undefined,
                fullOutputPath: tempFilePath,
              },
            });
          }
        };

        if (child.stdout) {
          child.stdout.on("data", handleData);
        }
        if (child.stderr) {
          child.stderr.on("data", handleData);
        }

        const onAbort = () => {
          if (child.pid) {
            killProcessTree(child.pid);
          }
        };

        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);

          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Nushell (nu) is not installed or not in PATH.\n" +
                  "Install: https://www.nushell.sh/book/installation.html",
              ),
            );
          } else {
            reject(err);
          }
        });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);

          if (tempFileStream) {
            tempFileStream.end();
          }

          if (signal?.aborted) {
            const buf = Buffer.concat(chunks);
            let output = buf.toString("utf-8");
            if (output) output += "\n\n";
            output += "Command aborted";
            reject(new Error(output));
            return;
          }

          if (timedOut) {
            const buf = Buffer.concat(chunks);
            let output = buf.toString("utf-8");
            if (output) output += "\n\n";
            output += "Command timed out after " + timeout + " seconds";
            reject(new Error(output));
            return;
          }

          const fullBuffer = Buffer.concat(chunks);
          const fullOutput = fullBuffer.toString("utf-8");

          const truncation = truncateTail(fullOutput);
          let outputText = truncation.content || "(no output)";

          let details: NushellToolDetails = {};

          if (truncation.truncated) {
            details = {
              truncation,
              fullOutputPath: tempFilePath,
            };

            const startLine = truncation.totalLines - truncation.outputLines + 1;
            const endLine = truncation.totalLines;

            if (truncation.lastLinePartial) {
              const lastLineSize = formatSize(
                Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"),
              );
              outputText +=
                "\n\n[Showing last " +
                formatSize(truncation.outputBytes) +
                " of line " +
                endLine +
                " (line is " +
                lastLineSize +
                ")" +
                ". Full output: " +
                (tempFilePath || "N/A") +
                "]";
            } else if (truncation.truncatedBy === "lines") {
              outputText +=
                "\n\n[Showing lines " +
                startLine +
                "-" +
                endLine +
                " of " +
                truncation.totalLines +
                ". Full output: " +
                (tempFilePath || "N/A") +
                "]";
            } else {
              outputText +=
                "\n\n[Showing lines " +
                startLine +
                "-" +
                endLine +
                " of " +
                truncation.totalLines +
                " (" +
                formatSize(DEFAULT_MAX_BYTES) +
                " limit)" +
                ". Full output: " +
                (tempFilePath || "N/A") +
                "]";
            }
          }

          if (code !== 0 && code !== null) {
            outputText += "\n\nCommand exited with code " + code;
            reject(new Error(outputText));
          } else {
            resolve({ content: [{ type: "text", text: outputText }], details });
          }
        });
      });
    },
  });
}
