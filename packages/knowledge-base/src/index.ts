import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Citation } from "@vinko/shared";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const require = createRequire(import.meta.url);

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".yml",
  ".yaml",
  ".py",
  ".sh",
  ".html",
  ".css"
]);

const PDF_EXTENSIONS = new Set([".pdf"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".data",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache"
]);

const MAX_FILE_SIZE_BYTES = 250_000;

interface KnowledgeDocument {
  id: string;
  path: string;
  text: string;
  tokens: Set<string>;
  tokenCounts: Map<string, number>;
  charTrigrams: Set<string>;
}

export interface KnowledgeSnippet extends Citation {
  score: number;
}

export interface RetrieveOptions {
  keywordWeight?: number;
  semanticWeight?: number;
  minSemanticScore?: number;
  maxPerPath?: number;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff_-]+/g)
    .filter((token) => token.length >= 2);
}

function buildTokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const previous = counts.get(token) ?? 0;
    counts.set(token, previous + 1);
  }
  return counts;
}

function buildCharTrigrams(input: string): Set<string> {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 3) {
    return new Set(normalized ? [normalized] : []);
  }
  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    grams.add(normalized.slice(index, index + 3));
  }
  return grams;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function splitIntoChunks(text: string, chunkSize = 1200, overlap = 180): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= chunkSize) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chunkSize);
    if (end < normalized.length) {
      const breakAt = normalized.lastIndexOf("\n", end);
      if (breakAt > start + 300) {
        end = breakAt;
      }
    }

    const piece = normalized.slice(start, end).trim();
    if (piece) {
      chunks.push(piece);
    }
    if (end >= normalized.length) {
      break;
    }
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function excerptAround(text: string, queryTokens: string[]): string {
  const lowered = text.toLowerCase();
  const token = queryTokens.find((entry) => lowered.includes(entry));
  if (!token) {
    return text.slice(0, 220).trim();
  }

  const index = lowered.indexOf(token);
  const start = Math.max(0, index - 110);
  const end = Math.min(text.length, index + 180);
  return text.slice(start, end).trim();
}

async function maybeReadPdf(filePath: string): Promise<string> {
  try {
    const pdfParse = require("pdf-parse") as (buffer: Buffer) => Promise<{ text: string }>;
    const buffer = await readFile(filePath);
    const parsed = await pdfParse(buffer);
    return parsed.text;
  } catch {
    return "";
  }
}

async function scanFiles(root: string, output: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await scanFiles(fullPath, output);
      continue;
    }

    output.push(fullPath);
  }
}

export class WorkspaceKnowledgeBase {
  private readonly roots: string[];

  private readonly refreshWindowMs: number;

  private documents: KnowledgeDocument[] = [];

  private lastIndexedAt = 0;

  constructor(roots: string[] = [PROJECT_ROOT], refreshWindowMs = 30_000) {
    this.roots = roots;
    this.refreshWindowMs = refreshWindowMs;
  }

  async refresh(force = false): Promise<void> {
    if (!force && this.documents.length > 0 && Date.now() - this.lastIndexedAt < this.refreshWindowMs) {
      return;
    }

    const nextDocuments: KnowledgeDocument[] = [];
    for (const root of this.roots) {
      const files: string[] = [];
      await scanFiles(root, files);

      for (const filePath of files) {
        const extension = path.extname(filePath).toLowerCase();
        if (!TEXT_EXTENSIONS.has(extension) && !PDF_EXTENSIONS.has(extension)) {
          continue;
        }

        const fileStats = await stat(filePath);
        if (fileStats.size > MAX_FILE_SIZE_BYTES) {
          continue;
        }

        const relativePathFromRoot = path.relative(root, filePath);
        const relativePath =
          this.roots.length === 1
            ? relativePathFromRoot
            : path.join(path.basename(root), relativePathFromRoot);
        const rawText = TEXT_EXTENSIONS.has(extension)
          ? await readFile(filePath, "utf8")
          : await maybeReadPdf(filePath);
        const text = rawText.trim();
        if (!text) {
          continue;
        }

        const chunks = splitIntoChunks(text);
        chunks.forEach((chunk, chunkIndex) => {
          const chunkTokens = tokenize(chunk);
          nextDocuments.push({
            id: `${relativePath}#${chunkIndex + 1}`,
            path: relativePath,
            text: chunk,
            tokens: new Set(chunkTokens),
            tokenCounts: buildTokenCounts(chunkTokens),
            charTrigrams: buildCharTrigrams(chunk)
          });
        });
      }
    }

    this.documents = nextDocuments;
    this.lastIndexedAt = Date.now();
  }

  async retrieve(query: string, limit = 5, options: RetrieveOptions = {}): Promise<KnowledgeSnippet[]> {
    await this.refresh();

    const queryTokens = tokenize(query);
    const queryTrigrams = buildCharTrigrams(query);
    if (queryTokens.length === 0 && queryTrigrams.size === 0) {
      return [];
    }

    const keywordWeight = Math.max(0, options.keywordWeight ?? 0.6);
    const semanticWeight = Math.max(0, options.semanticWeight ?? 0.4);
    const minSemanticScore = Math.max(0, options.minSemanticScore ?? 0.08);
    const maxPerPath = Math.max(1, options.maxPerPath ?? 2);
    const queryTokenCount = Math.max(1, queryTokens.length);

    const ranked = this.documents
      .map((document) => {
        let keywordRawScore = 0;
        for (const token of queryTokens) {
          const hitCount = document.tokenCounts.get(token) ?? 0;
          if (hitCount > 0) {
            keywordRawScore += Math.min(3, hitCount);
            if (document.path.toLowerCase().includes(token)) {
              keywordRawScore += 1;
            }
          }
        }

        const keywordScore = keywordRawScore / (queryTokenCount * 3);
        const semanticScore = jaccardSimilarity(queryTrigrams, document.charTrigrams);
        const hybridScore = keywordWeight * keywordScore + semanticWeight * semanticScore;

        return {
          id: document.id,
          path: document.path,
          excerpt: excerptAround(document.text, queryTokens),
          keywordScore,
          semanticScore,
          score: Number(hybridScore.toFixed(6))
        };
      })
      .filter((entry) => entry.keywordScore > 0 || entry.semanticScore >= minSemanticScore)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.id.localeCompare(right.id));

    const selected: KnowledgeSnippet[] = [];
    const pathCounts = new Map<string, number>();
    for (const entry of ranked) {
      const used = pathCounts.get(entry.path) ?? 0;
      if (used >= maxPerPath) {
        continue;
      }
      pathCounts.set(entry.path, used + 1);
      selected.push({
        path: entry.path,
        excerpt: entry.excerpt,
        score: entry.score
      });
      if (selected.length >= limit) {
        break;
      }
    }

    return selected;
  }
}
