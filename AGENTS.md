# Pi Extensions

Collection of extensions for [pi-mono](https://github.com/badlogic/pi-mono) coding-agent.

## Structure

```text
extensions/
├── <extension-name>/
│   ├── index.ts          # Entry point (exports default function)
│   ├── package.json      # Dependencies + pi.extensions config
│   ├── tsconfig.json     # TypeScript config
│   ├── AGENTS.md         # Extension-specific docs
│   └── README.md         # User documentation
```

## Commands

### Type check all extensions

```bash
for dir in extensions/*/; do (cd "$dir" && npx tsc --noEmit); done
```

### Type check single extension

```bash
cd extensions/<name> && npx tsc --noEmit
```

### Install dependencies

```bash
cd extensions/<name> && npm install
```

### Test extension loads

```bash
pi -e ./extensions/<name> -p "list your tools"
```

## Creating a new extension

1.  Create folder: `extensions/<name>/`
2.  Add `package.json` with `"pi": { "extensions": ["./index.ts"] }`
3.  Add `tsconfig.json` (copy from existing extension)
4.  Add `index.ts` exporting default function receiving `ExtensionAPI`
5.  Run `npm install`

## Key imports

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
```

## Dev dependencies (for type checking)

```json
{
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "^0.55.0",
    "@sinclair/typebox": "^0.34.48"
  }
}
```

## Reference

-   [pi-mono extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
-   [Extension examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions)
