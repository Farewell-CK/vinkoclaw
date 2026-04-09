export interface ParsedTemplateToggleCommand {
  action: "enable" | "disable";
  templateQuery: string;
}

function cleanTemplateQuery(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`“”‘’]+/, "")
    .replace(/["'`“”‘’]+$/, "")
    .replace(/[，。,.;；]+$/, "")
    .trim();
}

export function parseTemplateToggleCommand(text: string): ParsedTemplateToggleCommand | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  const patterns: Array<{ action: "enable" | "disable"; regex: RegExp }> = [
    { action: "disable", regex: /(?:^|\s)(?:暂停|停用|禁用|关闭)\s*(?:模板|template)\s*[:：]?\s*(.+)$/i },
    { action: "disable", regex: /(?:^|\s)(?:pause|disable)\s+template\s+(.+)$/i },
    { action: "disable", regex: /(?:模板|template)\s*[:：]?\s*(.+?)\s*(?:暂停|停用|禁用|关闭)$/i },
    { action: "enable", regex: /(?:^|\s)(?:启用|开启|恢复)\s*(?:模板|template)\s*[:：]?\s*(.+)$/i },
    { action: "enable", regex: /(?:^|\s)(?:enable|resume)\s+template\s+(.+)$/i },
    { action: "enable", regex: /(?:模板|template)\s*[:：]?\s*(.+?)\s*(?:启用|开启|恢复)$/i }
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern.regex);
    if (!match?.[1]) {
      continue;
    }
    const templateQuery = cleanTemplateQuery(match[1]);
    if (!templateQuery) {
      continue;
    }
    return {
      action: pattern.action,
      templateQuery
    };
  }

  return undefined;
}
