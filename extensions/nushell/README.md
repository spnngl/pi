# Nushell Extension for Pi

Replaces the built-in `bash` tool with [Nushell](https://www.nushell.sh/).
Nushell runs every external CLI (git, npm, docker, rg, make, …) **and** provides
structured-data pipelines that replace bash + python/pandas.

## Prerequisites

Nushell must be installed and available as `nu` on `PATH`.
See <https://www.nushell.sh/book/installation.html>.

## Usage

```bash
pi -e ./extensions/nushell
```

The built-in `bash` tool is overridden. The LLM sees one tool called `bash`
whose description teaches it nushell syntax. All external CLI commands work
unchanged; structured data operations use nushell's native pipeline syntax.

### Tool parameters

| Parameter | Type     | Description                 |
| --------- | -------- | --------------------------- |
| `command` | `string` | Nushell command to execute  |
| `timeout` | `number` | Optional timeout in seconds |

## How it works

-   Overrides the built-in `bash` tool by registering with `name: "bash"`
-   Spawns `nu -c <command>` as a child process
-   Uses `ctx.cwd` from the extension context as working directory
-   Streams stdout + stderr live to the pi UI during execution
-   Applies tail truncation (2000 lines / 50KB, whichever is hit first)
-   Saves full output to a temp file when truncated
-   Non-zero exit codes are reported as errors
-   Supports abort (Escape) and timeout

## Key differences from bash

| Bash                         | Nushell                                     |
| ---------------------------- | ------------------------------------------- |
| `cmd1 && cmd2`               | `cmd1; cmd2`                                |
| `$VAR` / `${VAR}`            | `$env.VAR`                                  |
| `$(cmd)`                     | `(cmd)`                                     |
| `x=42`                       | `let x = 42`                                |
| `"hello $x"`                 | `$"hello ($x)"`                             |
| `> file` / `>> file`         | `o> file` / `o>> file`                      |
| `> /dev/null 2>&1`           | `o+e>\| ignore`                             |
| `cat file`                   | `open --raw file`                           |
| `find . -name '*.ts'`        | `glob **/*.ts` or `^find . -name '*.ts'`    |
| `curl URL \| jq .field`      | `http get URL \| get field`                 |
| `command &`                  | `job spawn { command }`                     |

The `^` prefix calls the system binary when a nushell built-in shadows it
(ls, cp, mv, rm, mkdir, sort, echo, which, find, ps, du, open, date, sleep).

## Development

```bash
cd extensions/nushell
npm install
npx tsc --noEmit
```
