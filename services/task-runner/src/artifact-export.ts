import path from "node:path";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdownToHtml(markdown: string, title: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const body: string[] = [];
  let inCodeBlock = false;
  let inList = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const text = paragraph.join(" ").trim();
    if (text) {
      body.push(`<p>${escapeHtml(text)}</p>`);
    }
    paragraph = [];
  };

  const closeList = () => {
    if (inList) {
      body.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      closeList();
      if (inCodeBlock) {
        body.push("</code></pre>");
        inCodeBlock = false;
      } else {
        body.push("<pre><code>");
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      body.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const hashes = headingMatch[1] ?? "#";
      const headingText = headingMatch[2] ?? "";
      const level = hashes.length;
      body.push(`<h${level}>${escapeHtml(headingText.trim())}</h${level}>`);
      continue;
    }
    const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      flushParagraph();
      if (!inList) {
        body.push("<ul>");
        inList = true;
      }
      const listText = listMatch[1] ?? "";
      body.push(`<li>${escapeHtml(listText.trim())}</li>`);
      continue;
    }
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  if (inCodeBlock) {
    body.push("</code></pre>");
  }

  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `  <title>${escapeHtml(title)}</title>`,
    "  <style>",
    "    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; margin: 2rem auto; max-width: 880px; padding: 0 1rem; color: #1f2937; }",
    "    h1, h2, h3, h4, h5, h6 { color: #111827; line-height: 1.25; }",
    "    pre { background: #111827; color: #f9fafb; padding: 1rem; overflow-x: auto; border-radius: 0.5rem; }",
    "    code { font-family: 'SFMono-Regular', Consolas, monospace; }",
    "    ul { padding-left: 1.25rem; }",
    "    p, li { white-space: pre-wrap; }",
    "  </style>",
    "</head>",
    "<body>",
    ...body,
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

function splitMarkdownRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function extractMarkdownTable(markdown: string): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index];
    const separatorLine = lines[index + 1];
    if (typeof headerLine !== "string" || typeof separatorLine !== "string") {
      continue;
    }
    const normalizedHeaderLine = headerLine.trim();
    const normalizedSeparatorLine = separatorLine.trim();
    if (!normalizedHeaderLine.includes("|") || !normalizedSeparatorLine.includes("|")) {
      continue;
    }
    const headers = splitMarkdownRow(normalizedHeaderLine);
    const separator = splitMarkdownRow(normalizedSeparatorLine);
    if (headers.length === 0 || headers.length !== separator.length || !isMarkdownSeparatorRow(separator)) {
      continue;
    }

    const rows = [headers];
    let rowIndex = index + 2;
    while (rowIndex < lines.length) {
      const rawLine = lines[rowIndex];
      if (typeof rawLine !== "string") {
        break;
      }
      const line = rawLine.trim();
      if (!line || !line.includes("|")) {
        break;
      }
      const row = splitMarkdownRow(line);
      if (row.length !== headers.length) {
        break;
      }
      rows.push(row);
      rowIndex += 1;
    }
    if (rows.length < 2) {
      return null;
    }
    return rows.map((row) => row.map((cell) => escapeCsv(cell)).join(",")).join("\n").concat("\n");
  }
  return null;
}

export interface CompanionArtifact {
  relativePath: string;
  content: string;
}

export function buildCompanionArtifacts(input: {
  relativePath: string;
  content: string;
  title: string;
}): CompanionArtifact[] {
  const ext = path.extname(input.relativePath).toLowerCase();
  if (ext !== ".md") {
    return [];
  }

  const basePath = input.relativePath.slice(0, -ext.length);
  const companions: CompanionArtifact[] = [
    {
      relativePath: `${basePath}.html`,
      content: renderMarkdownToHtml(input.content, input.title)
    },
    {
      relativePath: `${basePath}.doc`,
      content: renderMarkdownToHtml(input.content, input.title)
    }
  ];

  const csv = extractMarkdownTable(input.content);
  if (csv) {
    companions.push({
      relativePath: `${basePath}.csv`,
      content: csv
    });
  }

  return companions;
}
