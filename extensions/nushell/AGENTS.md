# Nushell Extension

Replaces the built-in `bash` tool with Nushell.
The tool description already contains the bash-to-nushell cheat sheet, syntax rules, and command reference.
This file covers **gotchas and tooling** not in the tool description.

## Common pitfalls

-   **`&&` / `||` don't exist** — use `;` to chain, `try { } catch { }` for error handling.
-   **`$var` in strings doesn't interpolate** — must use `$"hello ($var)"` with parens.
-   **`find` is not `^find`** — nushell `find` searches text. Use `glob **/*.ext` for file search.
-   **`open` parses files** — use `open --raw` for plain text (like `cat`).
-   **Closures need explicit parameter** — `each {|it| $it.name }` not `each { .name }` (no space between `{` and `|`).
-   **Semicolons inside `{ }` blocks** — `{ cmd1; cmd2 }` works, but `{ cmd1 && cmd2 }` does not.
-   **`2>` / `1>` / `&>` don't exist** - use `out>` / `err>` / `out+err>`
-   **Use `http` command instead of `curl`**

## Quality tooling for .nu scripts

When writing or editing `.nu` files, use these tools:

1.  `nu --ide-check 10 script.nu` — parse error diagnostics as JSON (built into nu)
2.  `nufmt script.nu` — official AST-based formatter
