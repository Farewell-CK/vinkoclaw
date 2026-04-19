#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_ROOT = path.join(ROOT, ".run", "harness");
const OUTPUT_DIR = path.join(ROOT, "docs", "04-delivery");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString();
}

function determineStatus(report) {
  if (report.ok === true && report.grade === "pass") {
    return "pass";
  }
  if (report.ok === true) {
    return "warn";
  }
  return "fail";
}

function suiteLabel(report) {
  return report.label || report.suite || "unknown";
}

function collectLatestReports() {
  const suites = [
    "product",
    "founder-delivery",
    "founder-ops",
    "founder-ops-recurring",
    "founder-research",
    "founder-research-recurring",
    "founder-recap",
    "founder-recap-recurring",
    "founder-implementation",
    "artifact-export",
    "persona",
    "collaboration",
    "skill-lifecycle"
  ];
  return suites
    .map((suite) => {
      const filePath = path.join(HARNESS_ROOT, suite, "latest.json");
      try {
        const report = readJson(filePath);
        return { suite, report };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildMarkdown(reports) {
  const now = new Date();
  const summary = {
    pass: 0,
    warn: 0,
    fail: 0
  };

  const rows = reports.map(({ suite, report }) => {
    const status = determineStatus(report);
    summary[status] += 1;
    return {
      suite,
      label: suiteLabel(report),
      status,
      grade: report.grade || "-",
      finishedAt: formatDateTime(report.finishedAt),
      durationMs: Number(report.durationMs || 0),
      detail: String(report.detail || report.outputTail || "-").replace(/\s+/g, " ").trim()
    };
  });

  const lines = [
    `# Test Report ${formatDate(now)}`,
    "",
    `Generated at: ${formatDateTime(now.toISOString())}`,
    "",
    "## Summary",
    "",
    `- Pass: ${summary.pass}`,
    `- Warn: ${summary.warn}`,
    `- Fail: ${summary.fail}`,
    "",
    "## Harness Matrix",
    "",
    "| Suite | Label | Status | Grade | Duration(ms) | Finished At |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...rows.map(
      (row) =>
        `| ${row.suite} | ${row.label} | ${row.status} | ${row.grade} | ${row.durationMs} | ${row.finishedAt} |`
    ),
    "",
    "## Notes",
    ""
  ];

  for (const row of rows) {
    lines.push(`### ${row.suite}`);
    lines.push("");
    lines.push(`- Status: ${row.status}`);
    lines.push(`- Grade: ${row.grade}`);
    lines.push(`- Detail: ${row.detail || "-"}`);
    lines.push("");
  }

  return lines.join("\n");
}

function main() {
  const reports = collectLatestReports();
  if (reports.length === 0) {
    process.stderr.write("[release-report] no harness reports found\n");
    process.exit(1);
  }
  const markdown = buildMarkdown(reports);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `test-report-${formatDate(new Date())}-harness-baseline.md`);
  writeFileSync(outputPath, markdown, "utf8");
  process.stdout.write(`[release-report] wrote ${path.relative(ROOT, outputPath)}\n`);
}

main();
