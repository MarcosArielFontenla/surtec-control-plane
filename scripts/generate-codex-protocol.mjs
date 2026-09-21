import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, "runner", "generated", "codex-app-server");
const relativeOut = relative(repoRoot, outDir);

if (relativeOut.startsWith("..") || isAbsolute(relativeOut)) {
  throw new Error(`refusing to generate outside the repository: ${outDir}`);
}

const executable = process.env.SURTEC_CODEX_BIN?.trim() || "codex";
const version = spawnSync(executable, ["--version"], {
  cwd: repoRoot,
  encoding: "utf8",
  shell: false,
  windowsHide: true,
});

if (version.status !== 0) {
  throw new Error(`unable to read Codex version: ${version.stderr || version.error?.message || "unknown error"}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const generated = spawnSync(executable, ["app-server", "generate-ts", "--out", outDir], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

if (generated.status !== 0) {
  throw new Error(`protocol generation failed with exit code ${generated.status ?? "unknown"}`);
}

writeFileSync(join(outDir, "VERSION"), `${version.stdout.trim()}\n`, "utf8");
console.log(`Generated App Server bindings in ${relativeOut} (${version.stdout.trim()})`);
