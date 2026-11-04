/**
 * Repository hygiene checks that linters don't cover:
 * - invisible / bidirectional control characters ("Trojan Source") in source and docs
 * - likely committed secrets (private keys, common token formats, .env files)
 * Exits non-zero with file:line for every finding.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(
    (f) => f && !f.endsWith("pnpm-lock.yaml") && !/\.(png|jpe?g|webp|mp4|ico|woff2?)$/.test(f),
  );

const invisible = /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/u;
const secrets: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Model API key", /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/],
  ["password in URL", /\b[a-z]+:\/\/[^\s:@/]+:(?!<password>)[^\s@/]{8,}@/],
];

const findings: string[] = [];
for (const file of files) {
  if (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith(".env.example"))
    findings.push(`${file}: .env file must not be committed`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    if (invisible.test(line))
      findings.push(`${file}:${i + 1}: invisible or bidi control character`);
    for (const [name, re] of secrets)
      if (re.test(line)) findings.push(`${file}:${i + 1}: possible ${name}`);
  });
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log(`source checks passed (${files.length} files)`);
