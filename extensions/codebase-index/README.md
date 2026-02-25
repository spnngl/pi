# Codebase Index Extension

A pi extension that indexes your codebase using Mistral's **codestral-embed** model and stores
embeddings in SQLite for semantic search.

## Features

-   **Semantic Search**: Search code using natural language queries
-   **Find Similar**: Find files/code similar to a given file or snippet
-   **Incremental Indexing**: Only re-indexes changed files
-   **Chunked Processing**: Handles large files by splitting into chunks

## Requirements

-   Mistral API key for embeddings

Uses `sql.js` (WebAssembly-based SQLite) for database storage, so no native module compilation is
required.

## Installation

1.  Install dependencies:

   ```bash
   cd /path/to/codebase-index
   npm install
   ```

2.  Set your Mistral API key:

   ```bash
   export MISTRAL_API_KEY="your-api-key"
   ```

   Get a key from: <https://console.mistral.ai/codestral>

## Usage

### Commands

| Command         | Description                     |
| --------------- | ------------------------------- |
| `/index`        | Index the codebase (run first!) |
| `/index-status` | Show indexing statistics        |
| `/index-clear`  | Clear all indexed data          |

### Tools (LLM can use these)

| Tool              | Description                                        |
| ----------------- | -------------------------------------------------- |
| `semantic_search` | Search code semantically with natural language     |
| `find_similar`    | Find files similar to a given file or code snippet |
| `index_codebase`  | Trigger indexing (for LLM to call)                 |

### Example Prompts

```text
"Find code related to authentication"
"Search for error handling patterns"
"Find files similar to src/auth/login.ts"
```

## How It Works

1.  **Indexing**: Files are chunked (~8KB each) and sent to codestral-embed
2.  **Storage**: Embeddings stored in `.pi/embeddings.db` (SQLite via sql.js)
3.  **Search**: Query embedded, cosine similarity computed against all chunks
4.  **Results**: Top matches returned with file paths and line numbers

## Configuration

Edit `index.ts` to customize:

-   `DEFAULT_PATTERNS`: File patterns to index (default: common code files)
-   `DEFAULT_IGNORE`: Patterns to skip (default: node_modules, .git, etc.)
-   `MAX_FILE_SIZE`: Max file size to index (default: 100KB)
-   `CHUNK_SIZE`: Characters per chunk (default: 8000)
-   `BATCH_SIZE`: Files per embedding batch (default: 10)

## Database Location

Embeddings are stored in:

```text
<project>/.pi/embeddings.db
```

Each project has its own index.

## Costs

Codestral-embed pricing:

-   ~$0.001 per 1K tokens
-   A typical file chunk is ~2K tokens
-   Indexing 1000 files ≈ $2-5

## Troubleshooting

### MISTRAL_API_KEY environment variable is required

-   Set `export MISTRAL_API_KEY=...` before running pi

### No results found

-   Run `/index` first to index the codebase

### Slow indexing

-   Normal for first run; subsequent runs only index changed files
-   Reduce `BATCH_SIZE` if hitting rate limits
