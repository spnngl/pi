# Codebase Index Extension

Semantic code search using Mistral's codestral-embed model + SQLite (sql.js).

## Tools registered

| Tool              | Description                       |
| ----------------- | --------------------------------- |
| `semantic_search` | Search code with natural language |
| `find_similar`    | Find similar files/code           |
| `index_codebase`  | Trigger indexing                  |

## Commands registered

| Command         | Description        |
| --------------- | ------------------ |
| `/index`        | Index the codebase |
| `/index-status` | Show index stats   |
| `/index-clear`  | Delete index DB    |

## Environment

-   `MISTRAL_API_KEY` - Required for embeddings

## Storage

-   `.pi/embeddings.db` - SQLite database (per project)
-   Embeddings stored as base64-encoded Float32Array (~5.5KB each)

## Dependencies

-   `sql.js` - WebAssembly SQLite (no native modules needed)
-   `@mistralai/mistralai` - Embedding API
-   `glob` / `ignore` - File discovery respecting .gitignore
