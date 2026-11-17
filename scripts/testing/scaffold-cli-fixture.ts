import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { scaffoldDirectoryIdentity } from "../../lib/harness/scaffold-files";
import { loadHarnessSource } from "../../lib/harness/source";
import { localGitEnvironment } from "../../lib/security/environment";

const repoRoot = resolve(".");
const prefix = "surtec-scaffold-cli-";
export const scaffoldFixtureProjectId = "fixture";
export const scaffoldFixtureMissingTemplate = ".agents/templates/entity.spec.yaml";
const tasks = ".agents/templates/feature.tasks.md";

function write(root: string, path: string, content: string | Buffer) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function scaffoldFixtureGit(root: string, ...args: string[]) {
  execFileSync("git", [
    "-C", root, "-c", "user.name=CLI Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "core.autocrlf=false", "-c", "commit.gpgSign=false", ...args,
  ], {
    env: { ...localGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "fixture-git-config") },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}

export function createScaffoldCliFixture() {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, prefix));
  const identity = scaffoldDirectoryIdentity(root);
  function dispose() {
    if (dirname(root) !== parent || !basename(root).startsWith(prefix) || scaffoldDirectoryIdentity(root) !== identity) {
      throw new Error("Unverified CLI fixture root");
    }
    rmSync(root, { recursive: true });
    if (lstatSync(root, { throwIfNoEntry: false }) !== undefined) throw new Error("CLI fixture cleanup incomplete");
  }

  try {
    const control = join(root, "control");
    const projects = join(root, "projects");
    const target = join(projects, scaffoldFixtureProjectId);
    const state = join(root, "state");
    write(target, "README.md", "Fixture baseline\n");
    scaffoldFixtureGit(target, "init", "--template=", "-b", "main");
    scaffoldFixtureGit(target, "add", "--", "README.md");
    scaffoldFixtureGit(target, "commit", "-m", "Synthetic baseline");
    write(target, "README.md", "Unrelated local edit\n");
    write(target, "AGENTS.md", "# Preserve the fixture primer\n");
    const trusted = loadHarnessSource(repoRoot);
    if (trusted.status !== "trusted" || !trusted.manifest || !trusted.registry) throw new Error("Reviewed source unavailable");
    for (const { path } of trusted.manifest.expected_entries) {
      write(control, path, readFileSync(resolve(repoRoot, trusted.registry.source.root, path)));
    }
    const manifestPath = trusted.registry.source.manifest;
    write(control, manifestPath, readFileSync(join(repoRoot, manifestPath)));
    write(control, "registry/project-archetypes.yml", readFileSync(join(repoRoot, "registry/project-archetypes.yml")));
    write(control, "registry/harness-sources.yml", stringify({
      ...trusted.registry, source: { ...trusted.registry.source, root: "." }, projects: {},
    }));
    write(control, "registry/agents.yml", "agents: []\n");
    write(control, "registry/projects.yml", `projects:\n  ${scaffoldFixtureProjectId}: {}\n`);
    write(target, tasks, readFileSync(join(control, tasks)));
    return {
      root, control, target, state, dispose,
      environment: { SURTEC_PROJECTS_ROOT: projects, SURTEC_STATE_DIR: state },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function runScaffoldFixtureProcess(
  fixture: Pick<ReturnType<typeof createScaffoldCliFixture>, "control" | "environment">,
  args: readonly string[],
  input?: string,
) {
  const loader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
  return spawnSync(process.execPath, ["--import", loader, join(repoRoot, "cli/surtec-scaffold.ts"), ...args], {
    cwd: fixture.control,
    env: { ...localGitEnvironment(), ...fixture.environment, TSX_DISABLE_CACHE: "1" },
    encoding: "utf8", windowsHide: true, timeout: 4000, maxBuffer: 256 * 1024, input,
  });
}
