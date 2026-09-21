import { lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const ALLOW_MARKER = "secret-scan: allow";
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const RULES = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "OpenAI API key", pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key", pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/ },
  { name: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: "Stripe live key", pattern: /(?:sk|rk)_live_[A-Za-z0-9]{16,}/ },
  { name: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  {
    name: "populated secret environment variable",
    pattern: /^\s*[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\s*=\s*["']?[^\s"'#]{12,}/,
  },
];

export function scanText(text, file = "<text>") {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const allowed = line.includes(ALLOW_MARKER) || (index > 0 && lines[index - 1].includes(ALLOW_MARKER));
    if (allowed) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) findings.push({ file, line: index + 1, rule: rule.name });
    }
  }
  return findings;
}

function repositoryFiles(root) {
  const listed = spawnSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  if (listed.status !== 0) throw new Error("git ls-files failed; secret scan did not run");
  return (listed.stdout ?? "").split("\0").filter(Boolean);
}

export function scanRepository(root) {
  const findings = [];
  for (const relativePath of repositoryFiles(root)) {
    const absolutePath = resolve(root, relativePath);
    let stat;
    try { stat = lstatSync(absolutePath); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES) continue;
    const content = readFileSync(absolutePath);
    if (content.includes(0)) continue;
    findings.push(...scanText(content.toString("utf8"), relativePath));
  }
  return findings;
}

function selfTest() {
  const githubToken = ["ghp", "_", "A".repeat(36)].join("");
  const openAiKey = ["sk", "-proj-", "B".repeat(32)].join("");
  assert.equal(scanText(`value=${githubToken}`).length, 1);
  assert.equal(scanText(`OPENAI_API_KEY=${openAiKey}`).length, 2);
  assert.equal(scanText(`# ${ALLOW_MARKER}\nvalue=${githubToken}`).length, 0);
  assert.equal(scanText("RAILWAY_TOKEN=").length, 0);
  console.log("Secret scanner self-test passed.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    const root = process.cwd();
    const findings = scanRepository(root);
    if (findings.length > 0) {
      console.error("Potential secrets detected:");
      for (const finding of findings) console.error(`- ${finding.file}:${finding.line} (${finding.rule})`);
      console.error(`Use '${ALLOW_MARKER}' only for an intentional non-secret fixture.`);
      process.exitCode = 1;
    } else {
      console.log(`Secret scan passed (${repositoryFiles(root).length} repository files checked).`);
    }
  }
}
