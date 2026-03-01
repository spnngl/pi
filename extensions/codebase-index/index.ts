/**
 * Codebase Index Extension
 *
 * Indexes your codebase using Mistral's codestral-embed model and stores
 * embeddings in SQLite for semantic search.
 *
 * Tools:
 * - index_codebase: Index files in the project
 * - semantic_search: Search code semantically
 * - find_similar: Find files similar to a given file
 *
 * Commands:
 * - /index: Start indexing the codebase
 * - /index-status: Show indexing status
 *
 * Environment:
 * - MISTRAL_API_KEY: Required for embedding generation
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Mistral } from "@mistralai/mistralai";
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import { glob } from "glob";
import ignore from "ignore";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Configuration
const EMBEDDING_MODEL = "codestral-embed";
const BATCH_SIZE = 10; // Files per batch
const MAX_FILE_SIZE = 100 * 1024; // 100KB max file size
const CHUNK_SIZE = 6000; // Target ~1500-2000 tokens per chunk
const MAX_EMBED_CHARS = 24000; // Hard limit before sending to API (codestral-embed max is 8192 tokens)

// File patterns to index
const DEFAULT_PATTERNS = [
  "**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,h,hpp,rb,php,swift,kt,scala,vue,svelte}",
  "**/*.{yaml,yml,json,toml,md,sql}",
  "**/Dockerfile*",
  "**/Containerfile*",
  "**/Makefile",
];

// Minimal fallback ignores (only used if no .gitignore exists)
const FALLBACK_IGNORE = [
  ".git/**",
  "node_modules/**",
  "vendor/**",
  "dist/**",
  "build/**",
  "out/**",
];

interface FileChunk {
  path: string;
  content: string;
  hash: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
}

interface SearchResult {
  path: string;
  content: string;
  score: number;
  startLine: number;
  endLine: number;
}

// Type guard helpers for SqlValue parsing
function asString(val: SqlValue): string {
  if (typeof val === "string") return val;
  if (val === null) return "";
  if (typeof val === "number") return String(val);
  return new TextDecoder().decode(val);
}

function asNumber(val: SqlValue): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") return Number(val);
  return 0;
}

export default function codebaseIndexExtension(pi: ExtensionAPI) {
  let db: Database | null = null;
  let mistral: Mistral | null = null;
  let indexingInProgress = false;
  let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

  // Get sql.js SQL instance (lazy init)
  async function getSqlJs() {
    if (!SQL) {
      SQL = await initSqlJs();
    }
    return SQL;
  }

  // Get database path
  function getDbPath(cwd: string): string {
    return path.join(cwd, ".pi", "embeddings.db");
  }

  // Initialize database
  async function initDb(cwd: string): Promise<Database> {
    const sqlJs = await getSqlJs();
    const dbPath = getDbPath(cwd);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    let database: Database;
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      database = new sqlJs.Database(buffer);
    } else {
      database = new sqlJs.Database();
    }

    database.run(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(path, chunk_index)
      );
    `);
    database.run(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);`);

    return database;
  }

  // Save database to disk
  function saveDb(cwd: string, vacuum = false) {
    if (!db) return;
    if (vacuum) {
      db.run("VACUUM");
    }
    const dbPath = getDbPath(cwd);
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  // Convert float array to base64 for compact storage (~5.5KB vs ~30KB for JSON)
  function embeddingToBase64(embedding: number[]): string {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    return buffer.toString("base64");
  }

  // Convert base64 back to float array
  function base64ToEmbedding(base64: string): number[] {
    const buffer = Buffer.from(base64, "base64");
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }

  // Initialize Mistral client
  function initMistral(): Mistral {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      throw new Error("MISTRAL_API_KEY environment variable is required");
    }
    return new Mistral({ apiKey });
  }

  // Generate embeddings for text
  async function embed(texts: string[]): Promise<number[][]> {
    if (!mistral) mistral = initMistral();

    // Truncate all texts to stay within token limits
    const safeTexts = texts.map((t) =>
      t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t,
    );

    const response = await mistral.embeddings.create({
      model: EMBEDDING_MODEL,
      inputs: safeTexts,
    });

    return response.data.map((d) => d.embedding).filter((e): e is number[] => e !== undefined);
  }

  // Check if file is likely binary or minified
  function isLikelyBinary(content: string): boolean {
    // Check for null bytes or high ratio of non-printable characters
    const nonPrintable = content
      .slice(0, 1000)
      .split("")
      .filter((c) => {
        const code = c.charCodeAt(0);
        return code < 32 && code !== 9 && code !== 10 && code !== 13;
      }).length;
    return nonPrintable > 10;
  }

  // Compute cosine similarity
  function cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Search chunks by embedding similarity
  function searchByEmbedding(
    queryEmbedding: number[],
    limit: number,
    excludePath?: string,
  ): SearchResult[] | null {
    if (!db) return null;

    const result = db.exec(`
      SELECT path, content, embedding, start_line, end_line
      FROM chunks WHERE embedding IS NOT NULL
    `);

    if (!result.length || !result[0].values.length) return null;

    const results: SearchResult[] = result[0].values
      .filter((row) => !excludePath || asString(row[0]) !== excludePath)
      .map((row) => {
        const [filePath, content, embeddingB64, startLine, endLine] = row;
        const embedding = base64ToEmbedding(asString(embeddingB64));
        return {
          path: asString(filePath),
          content: asString(content),
          score: cosineSimilarity(queryEmbedding, embedding),
          startLine: asNumber(startLine),
          endLine: asNumber(endLine),
        };
      });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // Split file into chunks
  function chunkFile(filePath: string, content: string): FileChunk[] {
    const lines = content.split("\n");
    const chunks: FileChunk[] = [];
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

    let currentChunk = "";
    let startLine = 1;
    let chunkIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Truncate very long lines (e.g., minified code that slipped through)
      if (line.length > CHUNK_SIZE) {
        line = line.slice(0, CHUNK_SIZE);
      }

      const newChunk = currentChunk + (currentChunk ? "\n" : "") + line;

      if (newChunk.length > CHUNK_SIZE) {
        // Save current chunk if it has content
        if (currentChunk) {
          chunks.push({
            path: filePath,
            content: currentChunk,
            hash,
            chunkIndex,
            startLine,
            endLine: i,
          });
          chunkIndex++;
        }
        // Start new chunk with current line
        currentChunk = line;
        startLine = i + 1;
      } else {
        currentChunk = newChunk;
      }
    }

    // Add remaining content
    if (currentChunk) {
      chunks.push({
        path: filePath,
        content: currentChunk,
        hash,
        chunkIndex,
        startLine,
        endLine: lines.length,
      });
    }

    return chunks;
  }

  // Get files to index
  async function getFilesToIndex(cwd: string): Promise<string[]> {
    const ig = ignore();

    // Use .gitignore if it exists, otherwise use minimal fallback
    const gitignorePath = path.join(cwd, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, "utf8"));
    } else {
      ig.add(FALLBACK_IGNORE);
    }

    const files: string[] = [];
    for (const pattern of DEFAULT_PATTERNS) {
      const matches = await glob(pattern, {
        cwd,
        nodir: true,
        absolute: false,
        dot: false,
      });
      files.push(...matches);
    }

    // Filter and dedupe
    const uniqueFiles = [...new Set(files)];
    return uniqueFiles.filter((f) => !ig.ignores(f));
  }

  // Index command
  pi.registerCommand("index", {
    description: "Index the codebase for semantic search",
    handler: async (_args, ctx) => {
      if (indexingInProgress) {
        ctx.ui.notify("Indexing already in progress", "warning");
        return;
      }

      indexingInProgress = true;
      ctx.ui.setStatus("index", "🔍 Indexing...");

      try {
        if (!db) db = await initDb(ctx.cwd);
        if (!mistral) mistral = initMistral();

        const files = await getFilesToIndex(ctx.cwd);
        ctx.ui.notify(`Found ${files.length} files to index`, "info");

        let indexed = 0;
        let skipped = 0;
        const allChunks: FileChunk[] = [];

        // Collect chunks from all files
        for (const file of files) {
          const fullPath = path.join(ctx.cwd, file);
          const stat = fs.statSync(fullPath);

          if (stat.size > MAX_FILE_SIZE) {
            skipped++;
            continue;
          }

          let content: string;
          try {
            content = fs.readFileSync(fullPath, "utf8");
          } catch {
            skipped++;
            continue; // Skip files that can't be read as UTF-8
          }

          // Skip binary or minified files
          if (isLikelyBinary(content)) {
            skipped++;
            continue;
          }

          const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

          // Check if already indexed with same hash
          const result = db.exec("SELECT hash FROM chunks WHERE path = ? LIMIT 1", [file]);
          const existing =
            result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : null;

          if (existing === hash) {
            skipped++;
            continue;
          }

          // Remove old chunks for this file
          db.run("DELETE FROM chunks WHERE path = ?", [file]);

          const chunks = chunkFile(file, content);
          allChunks.push(...chunks);
          indexed++;

          if (indexed % 50 === 0) {
            ctx.ui.setStatus("index", `🔍 Collected ${indexed}/${files.length - skipped} files...`);
          }
        }

        ctx.ui.notify(`Embedding ${allChunks.length} chunks from ${indexed} files...`, "info");

        // Batch embed and store
        for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
          const batch = allChunks.slice(i, i + BATCH_SIZE);
          // Truncate to stay within token limits (codestral-embed max is 8192 tokens)
          const texts = batch.map((c) => {
            const text = `File: ${c.path}\n\n${c.content}`;
            return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
          });

          try {
            const embeddings = await embed(texts);

            for (let j = 0; j < batch.length; j++) {
              const chunk = batch[j];
              // Store embedding as base64 (~5.5KB vs ~30KB for JSON)
              const embeddingB64 = embeddingToBase64(embeddings[j]);
              db.run(
                `INSERT INTO chunks (path, hash, chunk_index, start_line, end_line, content, embedding)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  chunk.path,
                  chunk.hash,
                  chunk.chunkIndex,
                  chunk.startLine,
                  chunk.endLine,
                  chunk.content,
                  embeddingB64,
                ],
              );
            }
          } catch (err) {
            ctx.ui.notify(`Embedding error: ${err}`, "error");
          }

          ctx.ui.setStatus(
            "index",
            `🔍 Embedded ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length}...`,
          );
        }

        // Save to disk (with vacuum to compact)
        saveDb(ctx.cwd, true);

        ctx.ui.setStatus("index", undefined);
        ctx.ui.notify(
          `✓ Indexed ${indexed} files (${skipped} skipped, ${allChunks.length} chunks)`,
          "info",
        );
      } catch (err) {
        ctx.ui.setStatus("index", undefined);
        ctx.ui.notify(`Indexing failed: ${err}`, "error");
      } finally {
        indexingInProgress = false;
      }
    },
  });

  // Index status command
  pi.registerCommand("index-status", {
    description: "Show codebase index status",
    handler: async (_args, ctx) => {
      if (!db) db = await initDb(ctx.cwd);

      const result = db.exec(`
        SELECT
          COUNT(DISTINCT path) as files,
          COUNT(*) as chunks,
          SUM(LENGTH(content)) as total_size
        FROM chunks
      `);

      const row = result[0]?.values[0];
      const files = row?.[0] ?? 0;
      const chunks = row?.[1] ?? 0;
      const totalSize = row?.[2] ?? 0;

      ctx.ui.notify(
        `Index: ${files} files, ${chunks} chunks, ${Math.round(Number(totalSize) / 1024)}KB`,
        "info",
      );
    },
  });

  // Clear index command
  pi.registerCommand("index-clear", {
    description: "Clear the codebase index",
    handler: async (_args, ctx) => {
      // Close db if open
      if (db) {
        db.close();
        db = null;
      }
      // Delete the file
      const dbPath = getDbPath(ctx.cwd);
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
      ctx.ui.notify("Index cleared. Run /index to rebuild.", "info");
    },
  });

  // Semantic search tool
  pi.registerTool({
    name: "semantic_search",
    label: "Semantic Search",
    description:
      "Search the codebase semantically using natural language. Returns relevant code snippets ranked by similarity. Use this when you need to find code related to a concept, not just literal text matches.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)", default: 10 })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      try {
        if (!db) db = await initDb(ctx.cwd);
        if (!mistral) mistral = initMistral();

        onUpdate?.({
          content: [{ type: "text", text: "Searching..." }],
          details: {},
        });

        const [queryEmbedding] = await embed([params.query]);
        const results = searchByEmbedding(queryEmbedding, params.limit || 10);

        if (!results) {
          return {
            content: [
              {
                type: "text",
                text: "No indexed content found. Run /index first to index the codebase.",
              },
            ],
            details: { resultCount: 0, query: params.query },
          };
        }

        const output = results
          .map(
            (r, i) =>
              `### ${i + 1}. ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n\`\`\`\n${r.content.slice(0, 1000)}${r.content.length > 1000 ? "\n..." : ""}\n\`\`\``,
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text: output || "No results found." }],
          details: { resultCount: results.length, query: params.query },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Search error: ${err}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Find similar files tool
  pi.registerTool({
    name: "find_similar",
    label: "Find Similar",
    description:
      "Find files similar to a given file or code snippet. Useful for finding related code, duplicate patterns, or similar implementations.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Path to file to find similar files to" })),
      code: Type.Optional(Type.String({ description: "Code snippet to find similar code to" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5)", default: 5 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const text = params.file
          ? fs.readFileSync(path.join(ctx.cwd, params.file), "utf8")
          : params.code;

        if (!text) {
          return {
            content: [{ type: "text", text: "Either 'file' or 'code' parameter is required" }],
            isError: true,
            details: {},
          };
        }

        if (!db) db = await initDb(ctx.cwd);
        if (!mistral) mistral = initMistral();

        const [queryEmbedding] = await embed([text.slice(0, CHUNK_SIZE)]);
        const results = searchByEmbedding(queryEmbedding, params.limit || 5, params.file);

        if (!results) {
          return {
            content: [{ type: "text", text: "No indexed content found. Run /index first." }],
            details: { resultCount: 0 },
          };
        }

        const output = results
          .map(
            (r, i) =>
              `### ${i + 1}. ${r.path}:${r.startLine}-${r.endLine} (similarity: ${(r.score * 100).toFixed(1)}%)\n\`\`\`\n${r.content.slice(0, 500)}${r.content.length > 500 ? "\n..." : ""}\n\`\`\``,
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text: output || "No similar files found." }],
          details: { resultCount: results.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Index codebase tool (for LLM to trigger)
  pi.registerTool({
    name: "index_codebase",
    label: "Index Codebase",
    description:
      "Index the codebase for semantic search. Run this before using semantic_search or find_similar tools. Only needed once or when files change significantly.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate) {
      // Trigger the index command
      pi.sendUserMessage("/index", { deliverAs: "followUp" });
      return {
        content: [
          {
            type: "text",
            text: "Indexing queued. This may take a few minutes for large codebases.",
          },
        ],
        details: {},
      };
    },
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    if (db) {
      db.close();
      db = null;
    }
  });
}
