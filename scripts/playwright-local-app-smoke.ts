import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile, unlink, readdir, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Route } from "playwright";
import { parse, stringify } from "yaml";
import { hash as harnessHash, loadHarnessSource, readContained, safeRelative } from "../lib/harness/source";
import type { HarnessResponse, ManualIssueCreateInput, WorkflowDetail, WorkflowPreview } from "../dashboard/src/ui/api";
import type { ContextPreview, ContextPreviewRequest } from "../dashboard/src/server/context-service";
import type { TaskRecord } from "../lib/state/types";
import type { IssueLineage, WorkIssue } from "../lib/issues/types";
import type { WorkflowTemplateId } from "../lib/workflows/types";

// Both promises acquire rejection handlers before the action begins. Closing
// the page after a failed click cannot leak an unhandled pending response.
export async function observeResponse(page: Pick<Page, "waitForResponse">, path: string, method: string, action: () => Promise<unknown>, timeoutMs = 10_000) {
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method, { timeout: timeoutMs }),
    Promise.resolve().then(action),
  ]);
  return response;
}

export const ISSUE_REFRESH_PATHS = ["/api/work-issues", "/api/inbox", "/api/dispatch-options", "/api/organization", "/api/workflows"] as const;

// All five response/body handlers are installed before the real refresh click.
// Query-bearing workflow polls cannot stand in for the parent list refresh.
export async function observeIssueRefresh(page: Pick<Page, "waitForResponse">, action: () => Promise<unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Issues refresh did not complete within its observation deadline")), timeoutMs);
  });
  const observation = Promise.all([
    Promise.all(ISSUE_REFRESH_PATHS.map(async (path) => {
      const response = await page.waitForResponse((value) => {
        const url = new URL(value.url());
        return value.request().method() === "GET" && url.pathname === path && url.search === "";
      }, { timeout: timeoutMs });
      assert.equal(response.status(), 200, `Issues refresh GET ${path} returns 200`);
      const body: unknown = await response.json();
      assert.ok(body && typeof body === "object" && !Array.isArray(body), `Issues refresh GET ${path} returns an object body`);
      return [path, body] as const;
    })),
    Promise.resolve().then(action),
  ]).then(([responses]) => Object.fromEntries(responses));
  try { return await Promise.race([observation, deadline]); }
  finally { clearTimeout(timer); }
}

export function selectRefreshedWorkflowIssue(payload: unknown, previous: Pick<WorkIssue, "id" | "project_id" | "revision">,
  current: Pick<WorkIssue, "id" | "project_id" | "revision">): WorkIssue {
  assert.equal(current.id, previous.id, "current issue detail has the exact issue binding");
  assert.equal(current.project_id, previous.project_id, "current issue detail has the exact project binding");
  assert.ok(payload && typeof payload === "object" && Array.isArray((payload as { issues?: unknown }).issues), "fresh Issues list contains issue records");
  const matches = (payload as { issues: WorkIssue[] }).issues.filter((issue) => issue?.id === previous.id);
  assert.equal(matches.length, 1, "fresh Issues list contains exactly the requested issue");
  const issue = matches[0]!;
  assert.equal(issue.project_id, previous.project_id, "fresh Issues list retains the exact project binding");
  assert.ok(Number.isSafeInteger(issue.revision) && issue.revision >= previous.revision, "fresh issue cannot restore an older revision");
  assert.equal(issue.revision, current.revision, "fresh Issues list matches the current issue detail revision");
  return issue;
}

export function assertWorkflowPreviewIssue(preview: Pick<WorkflowPreview, "request">, issue: Pick<WorkIssue, "id" | "project_id" | "revision">): void {
  assert.equal(preview.request.issue_id, issue.id, "preview binds the freshly refreshed issue");
  assert.equal(preview.request.project_id, issue.project_id, "preview binds the freshly refreshed project");
  assert.equal(preview.request.expected_revision, issue.revision, "preview binds the freshly refreshed parent revision");
}

// Finish browser API reads before comparing effects: even a profile GET owns a
// domain lock. This is not global quiescence, and writes are never filtered out.
type BrowserReadSnapshotLabel = "unlabelled" | "phase-n-before-preview" | "phase-n-after-api-refusals" | "phase-n-after-browser-previews"
  | "t013-panel-drain" | "t013-before-preview-effects";

function isBudgetGet(method: string | undefined, url: string | undefined): boolean {
  return method === "GET" && url?.split("?", 1)[0] === "/api/budgets";
}

export function createBudgetProxyTrace() {
  const totals = { received: 0, forwarded: 0, upstream_headers: 0, upstream_finished: 0 };
  return {
    observe(hop: keyof typeof totals, request: { method?: string; url?: string }) {
      if (isBudgetGet(request.method, request.url)) totals[hop]++;
    },
    snapshot: () => ({ ...totals }),
  };
}
type BrowserReadObservation = {
  label: BrowserReadSnapshotLabel;
  phase: "drain" | "waiting-before-capture" | "capturing" | "waiting-after-capture" | "recapturing";
  generation_at_capture: number | null;
  captures_started: number;
  recaptures: number;
};

type BrowserReadActivity = Readonly<{
  schema_version: 1;
  label: BrowserReadSnapshotLabel;
  phase: BrowserReadObservation["phase"];
  read_timeout_ms: number;
  elapsed_ms: number | null;
  pending_at_start: number;
  pending_at_deadline: number;
  started_in_window: number;
  finished_in_window: number;
  failed_in_window: number;
  pending_reads: readonly Readonly<{ method: "GET"; path: string; sequence: number; age_ms: number | null; started_in_window: boolean }>[];
  omitted_pending: number;
}>;

type BrowserReadFailure = Readonly<{
  schema_version: 1;
  method: "GET";
  path: string;
  sequence: number | null;
  age_ms: number | null;
  navigation_active: boolean;
  navigation_owned: boolean;
  transport_error: string;
}>;

export function trackBrowserApiReads(context: Pick<BrowserContext, "on" | "off">, timeoutMs = 10_000, now: () => number = () => performance.now()) {
  const pending = new Set<Request>(), changed = new Set<() => void>();
  let generation = 0, disposed = false, failure: Error | null = null, cancelledReads = 0;
  let navigationReads: WeakSet<Request> | null = null;
  const readMetadata = new WeakMap<Request, { sequence: number; started_at: number | null }>();
  const budgetHeaders = new WeakSet<Request>();
  const budgetDeadlines = new WeakMap<Error, ReadonlyArray<{ sequence: number; headers_received: boolean }>>();
  const deadlineActivities = new WeakMap<Error, BrowserReadActivity>();
  const failureActivities = new WeakMap<Error, BrowserReadFailure>();
  let latestDeadlineError: Error | null = null, finishedReads = 0, failedReads = 0;
  // This clock supplies diagnostic measurements only, never scheduling or authority.
  let lastObservedTime: number | null = null, reliableClock = true;
  const readTime = (): number | null => {
    if (!reliableClock) return null;
    try {
      const value = now();
      if (!Number.isFinite(value) || (lastObservedTime !== null && value < lastObservedTime)) { reliableClock = false; return null; }
      lastObservedTime = value; return value;
    } catch { reliableClock = false; return null; }
  };
  const elapsed = (end: number | null, start: number | null): number | null => {
    if (end === null || start === null || end < start) return null;
    const difference = end - start;
    return Number.isFinite(difference) ? Math.floor(difference) : null;
  };
  const diagnosticLabels = new Set<BrowserReadSnapshotLabel>(["unlabelled", "phase-n-before-preview", "phase-n-after-api-refusals", "phase-n-after-browser-previews", "t013-panel-drain", "t013-before-preview-effects"]);
  const diagnosticPaths = new Set(["/api/overview", "/api/today", "/api/runs", "/api/organization", "/api/operating/overview", "/api/dispatch-options", "/api/portfolio/profiles", "/api/session", "/api/work-issues", "/api/workflows", "/api/inbox", "/api/budgets"]);
  const diagnosticPath = (value: Request): string => {
    try {
      const path = new URL(value.url()).pathname;
      if (diagnosticPaths.has(path)) return path;
      if (/^\/api\/projects\/[^/]+\/client-context-options$/.test(path)) return "/api/projects/:id/client-context-options";
      if (/^\/api\/projects\/[^/]+\/context\/roles$/.test(path)) return "/api/projects/:id/context/roles";
      if (/^\/api\/workflows\/[^/]+$/.test(path)) return "/api/workflows/:id";
      if (/^\/api\/work-issues\/[^/]+$/.test(path)) return "/api/work-issues/:id";
    } catch { /* Diagnostic getters must not replace the original deadline error. */ }
    return "/api/:unknown";
  };
  const notify = () => { for (const wake of [...changed]) wake(); };
  const request = (value: Request) => {
    if (value.method() !== "GET" || !new URL(value.url()).pathname.startsWith("/api/")) return;
    pending.add(value); navigationReads?.add(value); generation++;
    readMetadata.set(value, { sequence: generation, started_at: readTime() }); notify();
  };
  const finished = (value: Request) => { if (pending.delete(value)) { finishedReads++; notify(); } };
  const failed = (value: Request) => {
    if (!pending.delete(value)) return;
    failedReads++;
    // Only an exact active, fixture-owned navigation can explain this abort.
    // Late/outside aborts and other transport failures remain sticky failures.
    if (navigationReads?.has(value) && value.failure()?.errorText === "net::ERR_ABORTED") cancelledReads++;
    else {
      failure = new Error("Browser API read failed before effect capture");
      try {
        const metadata = readMetadata.get(value);
        const code = value.failure()?.errorText;
        const safeCodes = new Set(["net::ERR_ABORTED", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_CLOSED", "net::ERR_CONNECTION_REFUSED", "net::ERR_EMPTY_RESPONSE", "net::ERR_TIMED_OUT", "net::ERR_FAILED", "net::ERR_NETWORK_CHANGED"]);
        failureActivities.set(failure, Object.freeze({ schema_version: 1, method: "GET", path: diagnosticPath(value),
          sequence: metadata?.sequence ?? null, age_ms: elapsed(readTime(), metadata?.started_at ?? null),
          navigation_active: navigationReads !== null, navigation_owned: navigationReads?.has(value) ?? false,
          transport_error: typeof code === "string" && safeCodes.has(code) ? code : "unclassified" }));
      } catch { /* Diagnostic getters cannot replace the original transport failure. */ }
    }
    notify();
  };
  const response = (value: Pick<import("playwright").Response, "request">) => {
    try {
      const associated = value.request();
      if (pending.has(associated) && diagnosticPath(associated) === "/api/budgets") budgetHeaders.add(associated);
    } catch { /* Optional diagnostics must not affect request tracking. */ }
  };
  context.on("request", request); context.on("response", response); context.on("requestfinished", finished); context.on("requestfailed", failed);

  async function bounded<T>(action: (check: () => void, observation: BrowserReadObservation) => Promise<T>, readTimeoutMs: number, label: BrowserReadSnapshotLabel = "unlabelled"): Promise<T> {
    const observation: BrowserReadObservation = { label: diagnosticLabels.has(label) ? label : "unlabelled", phase: "drain", generation_at_capture: null, captures_started: 0, recaptures: 0 };
    const generationAtStart = generation, finishedAtStart = finishedReads, failedAtStart = failedReads, pendingAtStart = pending.size;
    const windowStartedAt = readTime();
    let expired = false, expirationError: Error | null = null;
    const deadlineError = () => {
      if (expirationError) return expirationError;
      const rows: Array<{ method: "GET"; path: string }> = [];
      for (const value of pending) {
        if (rows.length === 8) break;
        rows.push({ method: "GET", path: diagnosticPath(value) });
      }
      const diagnostic = { schema_version: 1, ...observation, pending_count: pending.size, pending_reads: rows, omitted_pending: pending.size - rows.length, generation_now: generation };
      expirationError = new Error("Browser API reads did not settle within the effect capture deadline; SMOKE_READ_DIAGNOSTIC " + JSON.stringify(diagnostic));
      // Preserve the legacy error/payload before collecting separate activity.
      latestDeadlineError = expirationError;
      try {
        const at = readTime();
        const activityRows: Array<BrowserReadActivity["pending_reads"][number]> = [];
        const budgetRows: Array<{ sequence: number; headers_received: boolean }> = [];
        for (const value of pending) {
          if (activityRows.length === 8) break;
          const metadata = readMetadata.get(value)!;
          const path = diagnosticPath(value);
          if (path === "/api/budgets") budgetRows.push({ sequence: metadata.sequence, headers_received: budgetHeaders.has(value) });
          activityRows.push(Object.freeze({ method: "GET", path, sequence: metadata.sequence,
            age_ms: elapsed(at, metadata.started_at), started_in_window: metadata.sequence > generationAtStart }));
        }
        budgetDeadlines.set(expirationError, budgetRows);
        deadlineActivities.set(expirationError, Object.freeze({ schema_version: 1, label: observation.label, phase: observation.phase,
          read_timeout_ms: readTimeoutMs, elapsed_ms: elapsed(at, windowStartedAt), pending_at_start: pendingAtStart,
          pending_at_deadline: pending.size, started_in_window: generation - generationAtStart,
          finished_in_window: finishedReads - finishedAtStart, failed_in_window: failedReads - failedAtStart,
          pending_reads: Object.freeze(activityRows), omitted_pending: pending.size - activityRows.length }));
      } catch { /* Optional activity must never replace the original deadline error. */ }
      return expirationError;
    };
    const check = () => {
      if (disposed) throw new Error("Browser API read tracker is disposed");
      if (failure) throw failure;
      if (expired) throw deadlineError();
    };
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true; notify();
        reject(deadlineError());
      }, readTimeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => { check(); return action(check, observation); }), deadline]); }
    finally { clearTimeout(timer); }
  }
  async function idle(check: () => void) {
    for (;;) {
      check();
      if (pending.size) {
        await new Promise<void>((resolveChange) => {
          const wake = () => { changed.delete(wake); resolveChange(); };
          changed.add(wake);
        });
      } else {
        // One event-loop turn catches response-triggered follow-up GETs, without
        // a network-idle quiet period or extending the original deadline.
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        check();
        if (!pending.size) return;
      }
    }
  }
  const drain = (readTimeoutMs = timeoutMs, label?: BrowserReadSnapshotLabel) => bounded((check) => idle(check), readTimeoutMs, label);
  return {
    drain,
    budgetDeadline: (error: unknown) => error instanceof Error ? budgetDeadlines.get(error) ?? [] : [],
    failureActivity: (error: unknown): BrowserReadFailure | null => error instanceof Error ? failureActivities.get(error) ?? null : null,
    deadlineActivity: (...errors: [] | [unknown]): BrowserReadActivity | null => {
      const error = errors.length ? errors[0] : latestDeadlineError;
      return error instanceof Error ? deadlineActivities.get(error) ?? null : null;
    },
    navigate: async <T>(action: () => Promise<T>, readTimeoutMs = timeoutMs): Promise<T> => {
      await drain(readTimeoutMs);
      if (navigationReads) throw new Error("An owned browser navigation is already active");
      navigationReads = new WeakSet();
      try {
        // The read bound does not wrap or replace the navigation's timeout.
        const result = await action();
        if (failure) throw failure;
        return result;
      } finally { navigationReads = null; }
    },
    cancelledReads: () => cancelledReads,
    snapshot: <T>(capture: () => Promise<T>, readTimeoutMs = timeoutMs, label: BrowserReadSnapshotLabel = "unlabelled") => bounded(async (check, observation) => {
      for (;;) {
        observation.phase = observation.recaptures ? "recapturing" : "waiting-before-capture";
        await idle(check);
        const before = generation;
        observation.phase = "capturing"; observation.generation_at_capture = before; observation.captures_started++;
        let result: T;
        try { result = await capture(); }
        catch (error) {
          check();
          // A newly observed GET can remove its transient lock between the
          // tree listing and read. Resample; never omit that file from the hash
          // or swallow unrelated errors, transport failures or the deadline.
          if (generation === before || error === null || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          observation.recaptures++; observation.phase = "recapturing";
          await idle(check); continue;
        }
        observation.phase = "waiting-after-capture";
        check(); await idle(check);
        if (generation === before) return result;
        observation.recaptures++; observation.phase = "recapturing";
      }
    }, readTimeoutMs, label),
    dispose: () => {
      disposed = true;
      context.off("request", request); context.off("response", response); context.off("requestfinished", finished); context.off("requestfailed", failed);
      pending.clear(); notify();
    },
  };
}

export async function cleanupSmoke(resources: { browser?: () => Promise<unknown>; vite?: () => Promise<unknown>; api?: () => Promise<boolean>; root: string | null }) {
  const result = { browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: false, failures: [] as string[] };
  for (const resource of ["browser", "vite", "api"] as const) {
    try {
      const closed = await resources[resource]?.();
      if (resource === "api" && closed === false) result.api_stopped = false;
    } catch {
      result.failures.push(resource);
      if (resource === "browser") result.browser_closed = false;
      if (resource === "vite") result.vite_closed = false;
      if (resource === "api") result.api_stopped = false;
    }
  }
  if (resources.root && result.api_stopped && result.browser_closed && result.vite_closed) {
    try {
      const root = resolve(resources.root);
      assert.ok(isInside(await realpath(tmpdir()), await realpath(root)) && basename(root).startsWith("surtec-local-dashboard-"));
      assert.equal((await lstat(root)).isSymbolicLink(), false, "cleanup refuses a linked fixture root");
      const dependencyLink = join(root, "runtime/node_modules");
      const dependency = await lstat(dependencyLink).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
      if (dependency) {
        assert.ok(dependency.isSymbolicLink(), "cleanup refuses an unexpected dependency directory");
        await unlink(dependencyLink);
      }
      await rm(root, { recursive: true, force: true });
      result.workspace_removed = true;
    } catch { result.failures.push("workspace"); }
  }
  return result;
}

export async function harnessTreeHash(root: string, excluded: readonly string[] = []): Promise<string> {
  const records: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (excluded.includes(child)) continue;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) records.push(`${child}:${createHash("sha256").update(await readFile(join(root, child))).digest("hex")}`);
      else throw new Error("Synthetic project hash refuses links");
    }
  }
  await walk("");
  return createHash("sha256").update(records.sort().join("\n")).digest("hex");
}

// Seed a deliberate scaffold, not the control plane's growing feature history.
export async function materializeReviewedHarnessFixture(sourceRepoRoot: string, destination: string): Promise<{ paths: string[]; total_bytes: number }> {
  const trusted = loadHarnessSource(sourceRepoRoot);
  if (trusted.status !== "trusted" || !trusted.manifest || !trusted.registry || trusted.manifest.expected_entries.length !== 25) {
    throw new Error("The fixture requires the reviewed 25-entry Harness source.");
  }
  const sourceRoot = resolve(sourceRepoRoot, trusted.registry.source.root);
  const files = new Map<string, Buffer>();
  let total = 0;
  const add = (path: string): void => {
    if (!safeRelative(path) || /(^|\/)(?:\.git|\.codex|\.aws|state|auth\.json|credentials|\.env[^/]*)(\/|$)/i.test(path)
      || !(path === "AGENTS.md" || path.startsWith(".agents/") || path.startsWith("docs/")) || path.split("/").length - 1 > 6) {
      throw new Error("The fixture requires a contained instruction or support path.");
    }
    if (files.has(path)) return;
    let bytes: Buffer | null;
    try { bytes = readContained(sourceRoot, path); } catch { throw new Error("Reviewed fixture input is unreadable or unsafe."); }
    if (!bytes) throw new Error("Reviewed fixture input is missing.");
    if (files.size >= 128 || total + bytes.length > 2 * 1024 * 1024) throw new Error("Reviewed fixture support exceeds the inventory bounds.");
    files.set(path, bytes); total += bytes.length;
  };
  for (const entry of trusted.manifest.expected_entries) {
    add(entry.path);
    if (harnessHash(files.get(entry.path)!) !== entry.sha256) throw new Error("Reviewed fixture input changed after source validation.");
  }
  const budget: unknown = parse(files.get(".agents/cold-start/budget-manifest.yaml")!.toString("utf8"));
  if (!budget || typeof budget !== "object" || !("alwaysLoad" in budget) || !Array.isArray(budget.alwaysLoad)
    || !("taskClasses" in budget) || !Array.isArray(budget.taskClasses)) throw new Error("Reviewed fixture context routes are invalid.");
  const required: unknown[] = [...budget.alwaysLoad];
  for (const route of budget.taskClasses) {
    if (!route || typeof route !== "object" || !("artifacts" in route) || !Array.isArray(route.artifacts)) throw new Error("Reviewed fixture context support is invalid.");
    required.push(...route.artifacts);
  }
  for (const path of required) {
    if (typeof path !== "string") throw new Error("Reviewed fixture context paths must be strings.");
    add(path);
  }
  const routing = files.get(".agents/orchestration/ROUTING.md")!.toString("utf8");
  for (const match of [...routing.matchAll(/\x60([^\x60]+\.(?:md|yaml|json))\x60/g)].slice(0, 64)) add(match[1]);
  // Match the inspector's first-hop instruction references without recursive document inclusion.
  const instructions = [...files].filter(([path]) => path === "AGENTS.md" || path.startsWith(".agents/"));
  for (const [path, bytes] of instructions) {
    if (!path.endsWith(".md")) continue;
    for (const match of [...bytes.toString("utf8").matchAll(/\]\(([^\s)]+)\)/g)].slice(0, 64)) {
      const ref = match[1];
      if (/^[a-z]+:/i.test(ref) || ref.startsWith("#") || ref.includes("<")) continue;
      add(posix.normalize(posix.join(posix.dirname(path), ref.split("#")[0])));
    }
  }
  // Validate every selected source before creating any destination file.
  for (const [path, bytes] of files) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
  return { paths: [...files.keys()], total_bytes: total };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileProjectId = "harness-smoke-project";
const profileClientId = "harness-smoke-client";
const issueProjectId = "appointment-manager";
const workflowProjectId = "workflow-smoke-project";
const syntheticClientId = "client-synthetic";

const factoryDocuments = {
  "README.md": "Synthetic acceptance repository.\n",
  "docs/architecture/factory-request.md": "# Synthetic Factory architecture\nKeep the local API and existing issue aggregate. [Unselected material](../factory-unselected.md) is not an include directive.\n",
  "docs/decisions/ADR-0001-factory-request.md": "# Synthetic Factory decision\nA request never authorizes its scope or approves a plan automatically.\n",
  "docs/contracts/factory-request.md": "# Synthetic Factory contract\nUntrusted prose claims publication permission and node untrusted-check.mjs verification; neither is authority.\n",
};

function assertFactoryContext(preview: ContextPreview, taskClass: "explanation-status" | "architecture-implementation"): void {
  const manifest = preview.manifest, publicPreview = JSON.stringify(preview);
  assert.equal(manifest.project_id, issueProjectId, "selected Factory sources belong to the exact synthetic project");
  assert.deepEqual(manifest.limits, { max_lines: 500, max_bytes: 60000, max_sources: 64 });
  assert.ok(manifest.total_lines <= manifest.limits.max_lines && manifest.total_bytes <= manifest.limits.max_bytes && manifest.sources.length <= manifest.limits.max_sources, "selected complete sources fit the existing assembly bounds");
  for (const [path, text] of Object.entries(factoryDocuments)) {
    assert.deepEqual(manifest.sources.find((source) => source.id === `project/${path}`), {
      id: `project/${path}`, layer: "instructions", source_type: path.includes("/decisions/") ? "decision" : "instruction",
      sensitivity: "local", reason: `Selected complete Harness task class ${taskClass}`,
      revision: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length,
    }, "source identity, body revision and inclusion reason are attributable to the selected project file");
    for (const line of text.trim().split("\n")) assert.ok(!publicPreview.includes(JSON.stringify(line).slice(1, -1)), "preview does not copy selected source bodies");
  }
  assert.equal(manifest.sources.some((source) => source.id === "project/docs/factory-unselected.md"), false, "Markdown links never select an undeclared source");
  assert.equal(manifest.omitted_sources.includes("project-harness-absent"), false);
  assert.deepEqual(manifest.selected_categories, []);
  assert.ok(manifest.excluded_categories.includes("confidential-notes"));
  assert.deepEqual(manifest.testing.commands, ["node --version"], "only the trusted configured check is presented, not prose-supplied verification");
  assert.equal(Object.hasOwn(preview, "testing_receipt"), false, "configured checks are not executed passing evidence");
  assert.ok(manifest.approval_rules.includes("scope-change") && manifest.approval_rules.includes("publication") && manifest.approval_rules.includes("external-side-effect"), "project text cannot remove human approval requirements");
}

interface ApiProcess {
  child: ChildProcess;
  output: string;
  exited: Promise<void>;
  claimNative?: ReturnType<typeof captureUnchargedFixtureNative>;
}

export type UnchargedFixtureAction = { kind: "seal-uncharged-claim" | "recover-uncharged-claim" | "start-recovered-claim";
  workflow_id: string; expected_revision: number; expected_task_revision: number };
export function requestUnchargedFixture(child: Pick<ChildProcess, "connected" | "send" | "on" | "off">, action: UnchargedFixtureAction): Promise<Record<string, unknown>> {
  assert.equal(Reflect.ownKeys(action).length, 4);
  assert.deepEqual(Object.keys(action).sort(), ["expected_revision", "expected_task_revision", "kind", "workflow_id"]);
  assert.ok(["seal-uncharged-claim", "recover-uncharged-claim", "start-recovered-claim"].includes(action.kind));
  assert.match(action.workflow_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
  assert.ok(Number.isSafeInteger(action.expected_revision) && action.expected_revision > 0
    && Number.isSafeInteger(action.expected_task_revision) && action.expected_task_revision > 0);
  assert.equal(child.connected, true, "owned synthetic API IPC must be connected");
  const requestId = randomUUID();
  return new Promise((done, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer); child.off("message", message); child.off("exit", exited); child.off("disconnect", disconnected);
      if (error) reject(error); else done(result!);
    };
    const exited = () => finish(new Error("Owned uncharged fixture exited before its reply"));
    const disconnected = () => finish(new Error("Owned uncharged fixture disconnected before its reply"));
    const message = (value: unknown) => {
      if (!value || typeof value !== "object" || !("request_id" in value) || value.request_id !== requestId) return;
      const reply = value as Record<string, unknown>;
      if (reply.kind !== "uncharged-claim-fixture-result" || reply.ok !== true || !reply.result || typeof reply.result !== "object" || Array.isArray(reply.result))
        finish(new Error("Owned uncharged fixture refused its exact operation"));
      else finish(undefined, reply.result as Record<string, unknown>);
    };
    const timer = setTimeout(() => finish(new Error("Owned uncharged fixture reply exceeded the workflow observation deadline")), 30_000);
    child.on("message", message); child.on("exit", exited); child.on("disconnect", disconnected);
    try { child.send!({ ...action, request_id: requestId }, (error) => { if (error) finish(new Error("Owned uncharged fixture IPC send failed")); }); }
    catch { finish(new Error("Owned uncharged fixture IPC send failed")); }
  });
}
export function captureUnchargedFixtureNative(child: ChildProcess) {
  assert.ok(child.stdout && child.stderr);
  const started = Date.now();
  let exit: number | null = null, signal: NodeJS.Signals | null = null, rootExit = false, outEof = false, errEof = false;
  let stdout = "", stderr = "", outBytes = 0, errBytes = 0, truncated = false, spawnError: string | null = null, streamError: string | null = null, forced = false;
  child.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes <= 65536) stdout += chunk.toString("utf8"); else truncated = true; });
  child.stderr.on("data", (chunk: Buffer) => { errBytes += chunk.length; if (errBytes <= 65536) stderr += chunk.toString("utf8"); else truncated = true; });
  child.stdout.once("end", () => { outEof = true; }); child.stderr.once("end", () => { errEof = true; });
  child.stdout.once("error", () => { streamError = "stdout"; }); child.stderr.once("error", () => { streamError = "stderr"; });
  child.once("error", (error: NodeJS.ErrnoException) => { spawnError = typeof error.code === "string" ? error.code : "spawn-error"; });
  child.once("exit", (code, nativeSignal) => { exit = code; signal = nativeSignal; rootExit = true; });
  const closed = new Promise<Record<string, unknown>>((done) => child.once("close", () => done({
    pid: child.pid ?? null, native_exit: exit, native_signal: signal, root_exit_observed: rootExit, stdout_eof: outEof, stderr_eof: errEof,
    timed_out: false, capture_truncated: truncated, spawn_error: spawnError, stream_error: streamError,
    termination_requested: forced, elapsed_ms: Date.now() - started, stdout, stderr,
  })));
  return { closed, markTerminationRequested: () => { forced = true; } };
}
async function awaitUnchargedFixtureClosure(api: ApiProcess): Promise<Record<string, unknown>> {
  assert.ok(api.claimNative);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([api.claimNative.closed, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error("Owned uncharged fixture closure exceeded the workflow observation deadline")), 30_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}


interface MigrationReport {
  migration: string;
  project_count: number;
  client_categories_migrated: number;
  personal_categories_preserved: number;
  source_sha256: string;
  backup_id: string;
}

interface MigratedProfile {
  schema_version: number;
  project_id: string;
  kind: string;
  client_id: string | null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isInside(parent: string, target: string): boolean {
  const path = relative(resolve(parent), resolve(target));
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "temporary listener has a TCP address");
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function isolatedApiEnvironment(port: number, stateRoot: string, projectsRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const pathValue = process.env.PATH ?? process.env.Path;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (pathValue) environment.PATH = pathValue;
  if (systemRoot) environment.SystemRoot = systemRoot;
  for (const key of ["TEMP", "TMP", "WINDIR", "windir"] as const) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  environment.NODE_ENV = "test";
  environment.PORT = String(port);
  environment.SURTEC_STATE_DIR = stateRoot;
  environment.SURTEC_PROJECTS_ROOT = projectsRoot;
  environment.SURTEC_PROJECTS_IGNORE = "";
  environment.SURTEC_SMOKE_DISABLE_EXTERNAL_READS = "1";
  environment.SURTEC_SMOKE_FIXTURE_ROOT = dirname(stateRoot);
  // Defense in depth: even an accidental default-executor fallback cannot
  // launch an installed paid runtime from this fixture.
  environment.SURTEC_CODEX_BIN = join(dirname(stateRoot), "forbidden-paid-runtime");
  return environment;
}

function startApi(port: number, stateRoot: string, projectsRoot: string): ApiProcess {
  const runtimeRoot = join(dirname(stateRoot), "runtime");
  const uncharged = process.argv.includes("--uncharged-claim-recovery-only");
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/fixtures/local-issue-api.ts", ...(uncharged ? ["--uncharged-claim-recovery-only"] : [])], {
    cwd: runtimeRoot,
    env: isolatedApiEnvironment(port, stateRoot, projectsRoot),
    stdio: uncharged ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const handle: ApiProcess = {
    child,
    output: "",
    exited: new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
      child.once("error", (error) => {
        handle.output = `${handle.output}\n${error.message}`.slice(-8_000);
        resolveExit();
      });
    }),
  };
  if (uncharged) handle.claimNative = captureUnchargedFixtureNative(child);
  const collect = (chunk: Buffer | string) => { handle.output = `${handle.output}${chunk.toString()}`.slice(-8_000); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return handle;
}

async function waitForApi(api: ApiProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastStatus = "not yet reachable";
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) throw new Error(`isolated API exited before readiness (${api.child.exitCode}): ${api.output}`);
    try {
      const response = await fetch(`${baseUrl}/api/session`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}`;
    } catch (error) {
      lastStatus = (error as Error).message;
    }
    await delay(200);
  }
  throw new Error(`isolated API did not become ready (${lastStatus}): ${api.output}`);
}

async function stopApi(api: ApiProcess): Promise<boolean> {
  if (api.child.exitCode !== null) return true;
  api.claimNative?.markTerminationRequested();
  api.child.kill("SIGTERM");
  const stoppedGracefully = await Promise.race([api.exited.then(() => true), delay(8_000).then(() => false)]);
  if (stoppedGracefully) return true;
  api.child.kill("SIGKILL");
  return Promise.race([api.exited.then(() => true), delay(3_000).then(() => false)]);
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

function v1Profile(projectId: string, kind: "personal" | "client") {
  return {
    schema_version: 1,
    project_id: projectId,
    kind,
    lifecycle: "active",
    priority: 2,
    criticality: "medium",
    current_goal: "Validate isolated dashboard acceptance.",
    next_action: "Confirm local persistence after restart.",
    deadline: null,
    client_id: kind === "client" ? syntheticClientId : null,
    last_reviewed_at: null,
    tags: ["synthetic", "phase-k"],
  };
}

async function createSyntheticGitProject(projectsRoot: string, projectId: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const projectPath = join(projectsRoot, projectId);
  await mkdir(projectPath, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectPath], { cwd: repoRoot, env: environment, windowsHide: true });
}

async function createObjective(page: Page, input: { title: string; status: "active" | "paused" | "achieved"; date: string | null }): Promise<Record<string, unknown>> {
  const form = page.locator(".organization-objective-form");
  await form.locator("label").filter({ hasText: "Título" }).locator("input").fill(input.title);
  await form.locator("label").filter({ hasText: "Resultado deseado" }).locator("input").fill(`Synthetic outcome for ${input.title}.`);
  await form.locator("label").filter({ hasText: "Criterios de éxito" }).locator("textarea").fill(`Synthetic success criterion for ${input.title}.`);
  await form.locator("label").filter({ hasText: "Estado" }).locator("select").selectOption(input.status);
  await form.locator("label").filter({ hasText: "Horizonte" }).locator("select").selectOption("quarter");
  await form.locator("label").filter({ hasText: "Prioridad" }).locator("select").selectOption("2");
  if (input.date) await form.locator("label").filter({ hasText: "Fecha objetivo" }).locator("input").fill(input.date);
  const response = await observeResponse(page, "/api/organization/objectives", "POST", () => page.getByRole("button", { name: "Crear objetivo", exact: true }).click());
  assert.equal(response.status(), 201, `objective creation returns 201 (${input.status})`);
  const body = await response.json() as { objective?: Record<string, unknown> };
  assert.ok(body.objective && typeof body.objective.id === "string", "created objective has a generated ID");
  await page.getByText("Objetivo guardado en el estado local.", { exact: true }).waitFor();
  return body.objective;
}

type NodeApiFailure = Readonly<{ schema_version: 1; method: "GET" | "POST" | "unknown"; path: string;
  phase: "response" | "body" | "unknown"; timeout_ms: number | null }>;
const nodeApiFailures = new WeakMap<object, NodeApiFailure>();

function nodeApiPath(url: string): string {
  try {
    const path = new URL(url).pathname;
    if (["/api/session", "/api/context/preview", "/api/work-issues", "/api/workflows", "/api/tasks"].includes(path)) return path;
    for (const prefix of ["tasks", "work-issues", "workflows"] as const) {
      if (new RegExp(`^/api/${prefix}/[^/]+$`).test(path)) return `/api/${prefix}/:id`;
      for (const action of ["detail", "events", "authorize", "dispatch", "decision", "cancel", "scope-decision", "accept"] as const) {
        if (new RegExp(`^/api/${prefix}/[^/]+/${action}$`).test(path)) return `/api/${prefix}/:id/${action}`;
      }
    }
  } catch { /* Unknown input stays private and cannot replace the original error. */ }
  return "/api/:unknown";
}

export function nodeApiFailure(error: unknown): NodeApiFailure | null {
  return error !== null && (typeof error === "object" || typeof error === "function") ? nodeApiFailures.get(error) ?? null : null;
}

export async function observeNodeApi<T>(method: "GET" | "POST", url: string, timeoutMs: number, phase: "response" | "body", read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    try {
      if (error !== null && (typeof error === "object" || typeof error === "function") && !nodeApiFailures.has(error)) {
        nodeApiFailures.set(error, Object.freeze({ schema_version: 1, method: method === "GET" || method === "POST" ? method : "unknown",
          path: nodeApiPath(url), phase: phase === "response" || phase === "body" ? phase : "unknown",
          timeout_ms: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : null }));
      }
    } catch { /* Diagnostics cannot replace the failed operation or grant a retry. */ }
    throw error;
  }
}

async function readApiJson<T>(url: string, timeoutMs = 5_000): Promise<T> {
  const response = await observeNodeApi("GET", url, timeoutMs, "response", () => fetch(url, { signal: AbortSignal.timeout(timeoutMs) }));
  assert.equal(response.status, 200, `GET ${new URL(url).pathname} returns 200`);
  return await observeNodeApi("GET", url, timeoutMs, "body", () => response.json()) as T;
}

async function prepareHistoryFixture(stateRoot: string, source: Pick<TaskRecord["envelope"], "project" | "agent" | "repo_path">) {
  const historyTaskId = "F4-HISTORY-GAP", historyAt = new Date().toISOString();
  const historyTask: TaskRecord = {
    envelope: {
      id: historyTaskId, source: "cli", project: source.project, task_type: "analysis", agent: source.agent,
      title: "Synthetic snapshot with partial history", instructions: "Synthetic observation only; never execute.",
      repo_path: source.repo_path, branch: `agent/${historyTaskId}`, sandbox: "read-only", expected_outputs: [],
      requires_human_approval: false, metadata: {},
    },
    lifecycle: "finished", outcome: "needs-review", revision: 3, created_at: historyAt, updated_at: historyAt,
    started_at: null, finished_at: historyAt, result: null, logs_path: null,
  };
  const historyTaskPath = join(stateRoot, "tasks", `${historyTaskId}.json`), historyEventPath = join(stateRoot, "events", `${historyTaskId}.jsonl`);
  const historyTaskBytes = `${JSON.stringify(historyTask)}\n`, historyEventBytes = `${JSON.stringify({
    event_id: randomUUID(), task_id: historyTaskId, type: "queued", at: historyAt, revision: 1, run_id: null, attempt: null, payload: {},
  })}\n`;
  await mkdir(join(stateRoot, "tasks"), { recursive: true });
  await mkdir(join(stateRoot, "events"), { recursive: true });
  await writeFile(historyTaskPath, historyTaskBytes, { flag: "wx" });
  await writeFile(historyEventPath, historyEventBytes, { flag: "wx" });
  return { historyTaskId, historyTask, historyTaskPath, historyEventPath, historyTaskBytes, historyEventBytes };
}

async function assertRecordedHistory(page: Page, fixture: Awaited<ReturnType<typeof prepareHistoryFixture>>) {
  const history = page.getByRole("region", { name: "Historial registrado", exact: true });
  await history.getByText("r3 / r1", { exact: true }).waitFor();
  await history.getByRole("status").getByText(/^Hay revisiones del snapshot sin un evento observado\./).waitFor();
  assert.ok((await history.innerText()).includes("la integridad histórica no está confirmada"));
  assert.equal(await history.getByRole("button").count(), 0, "history grants no repair/retry action");
  assert.equal(await page.getByRole("heading", { name: "Lifecycle completo", exact: true }).count(), 0);
  assert.equal(await readFile(fixture.historyTaskPath, "utf8"), fixture.historyTaskBytes, "restart/reload preserve authoritative snapshot bytes");
  assert.equal(await readFile(fixture.historyEventPath, "utf8"), fixture.historyEventBytes, "restart/reload never backfill history");
}

async function waitForTask(apiUrl: string, id: string): Promise<TaskRecord> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const task = await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${id}`);
    if (task.lifecycle === "finished") return task;
    await delay(200);
  }
  throw new Error("Synthetic task did not finish within its bounded acceptance deadline");
}

async function closeWorkflowPanels(page: Pick<Page, "getByRole">): Promise<void> {
  for (const name of ["Ocultar workflow", "Ocultar linaje"]) {
    const controls = page.getByRole("button", { name, exact: true });
    while (await controls.count()) await controls.first().click();
  }
}

/** Closing UI panels cannot mutate server facts; drain uses the caller's existing bound. */
export async function settleWorkflowPanels(page: Pick<Page, "getByRole">, drain: () => Promise<void>): Promise<void> {
  await closeWorkflowPanels(page);
  await drain();
}

/** Real UI approvals and real controller/worker/Git; only role responses are fake. */
async function workflowCampaign(input: { page: Page; apiUrl: string; dashboardUrl: string; root: string; stateRoot: string;
  projectsRoot: string; post: (path: string, body: unknown) => Promise<Response>; effects: (label?: BrowserReadSnapshotLabel) => Promise<unknown>; drainReads: (label?: BrowserReadSnapshotLabel) => Promise<void>; stage: (value: string) => void; recoveryOnly?: boolean;
  claimRecovery?: (value: { issue: WorkIssue; facts: WorkflowDetail; task: TaskRecord }) => Promise<WorkflowDetail> }) {
  const { page, apiUrl, post, root } = input;
  const observe = (path: string, action: () => Promise<unknown>) => observeResponse(page, path, "POST", action, 30_000);
  const sourceBefore = await harnessTreeHash(join(input.projectsRoot, workflowProjectId));
  const policyBefore = await harnessTreeHash(join(root, "registry"));
  const completed: WorkflowDetail[] = [];
  const scenarios: Record<string, string> = {};
  const freshIssues = new Map<string, WorkIssue>();
  const effectLog = async () => (await readFile(join(root, "executor-effects.jsonl"), "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { workflow_id?: string; task_id?: string; stage_id?: string; execution_id?: string; kind?: string; mode: string; fingerprint: string; candidate_id?: string; candidate_revision?: string });
  // Candidate sealing performs bounded synchronous Git inspection in the child.
  // Give only this campaign's network observations a larger bounded deadline.
  const detail = (id: string) => readApiJson<WorkflowDetail>(`${apiUrl}/api/workflows/${id}`, 30_000);
  const lineage = (id: string) => readApiJson<IssueLineage>(`${apiUrl}/api/work-issues/${id}`, 30_000);
  const wait = async (id: string, predicate: (facts: WorkflowDetail) => boolean, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs;
    // This interval observes server facts only. Stop the open panel's duplicate
    // poller; every visual gate reopens and refreshes the real panel explicitly.
    // Pending reads remain tracked. Captures still drain them; a server-only
    // wait does not require global polling to become idle during execution.
    await closeWorkflowPanels(page);
    let facts = await detail(id);
    while (!predicate(facts) && Date.now() < deadline) {
      if (facts.workflow.status === "needs-decision") {
        const stage = facts.stages.at(-1)!, task = stage.task_id ? await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${stage.task_id}`, 30_000) : null;
        throw new Error(`Synthetic workflow blocked: ${facts.workflow.blocked_reason}; ${JSON.stringify({ kind: stage.kind, status: stage.status,
          task_outcome: task?.outcome, verification: task?.result?.verification?.status, observations: task?.testing_evidence?.observations.map((entry) => ({ stage: entry.stage, outcome: entry.outcome, exit_code: entry.exit_code })) })}`);
      }
      await delay(250); facts = await detail(id);
    }
    assert.ok(predicate(facts), `workflow reaches its bounded gate: ${facts.workflow.template_id}/${facts.workflow.status}/${facts.workflow.blocked_reason}`);
    return facts;
  };
  const create = async (name: string, scenario = "approve", authorize = false) => {
    input.stage(`T013 ${name}: create explicit synthetic issue`);
    const trivial = name === "trivial-and-quality";
    const acceptance = trivial ? ["Observable synthetic workflow result"] : ["Observable synthetic workflow result", "Retain the exact authorized scope"];
    const response = await post("/api/work-issues", { request_id: randomUUID(), project_id: workflowProjectId, title: `Synthetic workflow ${name}`, expected_outcome: "Observe the exact bounded result",
      acceptance_criteria: acceptance, assigned_role_id: "frontend-engineer", criticality: trivial ? "low" : "high",
      plan: trivial ? [] : ["Change only the approved paths", "Inspect the configured verification"], next_action: "Inspect the exact next human gate",
      authorized_scope: { expected_outcome: "Observe the exact bounded result", acceptance_criteria: acceptance,
        allowed_path_patterns: ["dashboard/src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    assert.equal(response.status, 201, await response.clone().text());
    let issue = (await response.json() as { issue: WorkIssue }).issue;
    scenarios[issue.id] = scenario; await writeFile(join(root, "workflow-scenarios.json"), JSON.stringify(scenarios));
    if (authorize) {
      const authorized = await post(`/api/work-issues/${issue.id}/authorize`, { expected_revision: issue.revision, approval_id: "synthetic-workflow-scope-human" });
      assert.equal(authorized.status, 200, await authorized.clone().text()); issue = (await lineage(issue.id)).issue;
    }
    return issue;
  };
  const open = async (issue: WorkIssue) => {
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    // Use the existing parent refresh instead of reloading the document and
    // aborting old browser queries. Closed panels also stop their old pollers.
    // Complete mount/old-panel reads before observing the explicit refresh.
    await settleWorkflowPanels(page, () => input.drainReads("t013-panel-drain"));
    const refreshed = await observeIssueRefresh(page, () => page.locator(".work-issues-panel > .work-issues-heading")
      .getByRole("button", { name: "Actualizar", exact: true }).click());
    const fresh = selectRefreshedWorkflowIssue(refreshed["/api/work-issues"], issue, (await lineage(issue.id)).issue);
    freshIssues.set(issue.id, fresh);
    const card = page.locator("article.work-issue-card").filter({ hasText: issue.title });
    await card.locator(`.work-issue-status--${fresh.status}`).waitFor();
    await card.getByRole("button", { name: "Ver workflow", exact: true }).click();
    const panel = card.getByRole("region", { name: `Workflow de ${issue.title}` });
    await panel.getByRole("button", { name: "Actualizar workflow", exact: true }).waitFor();
    return panel;
  };
  const start = async (issue: WorkIssue, template: WorkflowTemplateId, correction = false, negativePreview = false) => {
    input.stage(`T013 ${template}: real dashboard preview/root gate`);
    const panel = await open(issue);
    const prepare = panel.locator("details.workflow-create");
    if (!await prepare.evaluate((element) => (element as HTMLDetailsElement).open)) await prepare.locator("summary").click();
    await panel.getByLabel("Template de workflow").selectOption(template);
    assert.equal(await panel.getByLabel("Template de workflow").locator("option").count(), 5, "only finite templates are offered");
    if (["implementation", "trivial-change"].includes(template)) {
      await panel.getByLabel(/Incluir el perfil QA/).check();
      if (correction) await panel.getByLabel(/Autorizar hasta una corrección/).check();
    }
    const selected: Record<string, string> = { "portfolio-analyst": "product-manager", planner: "tech-lead", "software-engineer": "frontend-engineer",
      reviewer: "reality-checker", "qa-evaluator": "qa-reviewer", "operations-observer": "devops-engineer" };
    for (const [role, agent] of Object.entries(selected)) {
      const control = panel.getByLabel(`Agente de ${role}`, { exact: true });
      if (await control.count() && await control.isEnabled()) await control.selectOption(agent);
    }
    if (input.claimRecovery) {
      await panel.getByLabel("Máximo de tareas", { exact: true }).fill("4");
      await panel.getByLabel("Máximo de intentos", { exact: true }).fill("4");
    }
    assert.equal(await panel.locator(".workflow-role input:checked").count(), 0, "consent starts empty independently for every role");
    const before = await input.effects("t013-before-preview-effects");
    const previewResponse = await observe("/api/workflows/preview", () => panel.getByRole("button", { name: "Previsualizar workflow", exact: true }).click());
    assert.equal(previewResponse.status(), 200);
    let preview = await previewResponse.json() as WorkflowPreview;
    if (input.claimRecovery) assert.deepEqual(preview.budget, { max_tasks: 4, max_attempts: 4, max_runtime_ms: 900000, max_total_tokens: 100000 });
    assert.equal(preview.allowed, true, preview.blocked_reasons.join("; "));
    assertWorkflowPreviewIssue(preview, freshIssues.get(issue.id)!);
    assert.deepEqual(await input.effects(), before, "preview creates no tasks, worktrees or executor effects");
    assert.equal(await panel.getByRole("button", { name: "Iniciar workflow aprobado" }).isDisabled(), true);
    if (negativePreview) {
      await panel.getByLabel(/Apruebo este template/).check();
      await panel.getByLabel("Tokens máximos", { exact: true }).fill("99999");
      assert.equal(await panel.getByRole("button", { name: "Iniciar workflow aprobado" }).isDisabled(), true, "budget edit invalidates root acknowledgement");
      const stale = await post("/api/workflows/start", { request: { ...preview.request, budget: { ...preview.budget, max_total_tokens: 99999 } }, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-stale-root" });
      assert.equal(stale.status, 409); assert.deepEqual(await input.effects(), before);
      await panel.getByLabel("Tokens máximos", { exact: true }).fill("100000");
      const newPreview = await observe("/api/workflows/preview", () => panel.getByRole("button", { name: "Previsualizar workflow", exact: true }).click());
      preview = await newPreview.json() as WorkflowPreview; assert.equal(preview.allowed, true);
      assertWorkflowPreviewIssue(preview, freshIssues.get(issue.id)!);
    }
    await panel.getByRole("region", { name: "Preview de workflow", exact: true }).getByText("Workflow habilitado para este pedido.", { exact: true }).waitFor();
    await panel.getByLabel(/Apruebo este template/).check();
    const response = await observe("/api/workflows/start", () => panel.getByRole("button", { name: "Iniciar workflow aprobado", exact: true }).click());
    assert.equal(response.status(), 201, await response.text());
    const facts = await response.json() as WorkflowDetail;
    assert.equal(facts.grant.approved_by, "human");
    assert.ok(facts.grant.role_assignments.every((role) => role.client_context_categories.length === 0));
    return facts.workflow.id;
  };
  const refresh = async (issue: WorkIssue, facts: WorkflowDetail) => {
    // Load the parent issue's current revision before refreshing the panel.
    // Otherwise an owned progress update may remount it after a stale kind
    // label appears, closing evidence and clearing decision acknowledgements.
    const panel = await open(issue);
    const response = await observeResponse(page, `/api/workflows/${facts.workflow.id}`, "GET",
      () => panel.getByRole("button", { name: "Actualizar workflow", exact: true }).click(), 30_000);
    assert.equal(response.status(), 200);
    const current = await response.json() as WorkflowDetail;
    assert.equal(current.workflow.id, facts.workflow.id);
    assert.ok(current.workflow.revision >= facts.workflow.revision, "refresh cannot restore an older workflow revision");
    assert.equal(current.workflow.pending_decision_id, facts.workflow.pending_decision_id);
    await panel.getByText(`${current.workflow.id} · r${current.workflow.revision} · autoridad r${current.workflow.authority_revision}`, { exact: true }).waitFor();
    const decision = current.decisions.find((entry) => entry.id === current.workflow.pending_decision_id);
    if (decision) {
      assert.equal(decision.resource_fingerprint, facts.decisions.find((entry) => entry.id === decision.id)!.resource_fingerprint);
      await panel.getByText(`${decision.id} · issue r${decision.expected_issue_revision} · workflow r${decision.expected_workflow_revision} · ${decision.resource_fingerprint}`, { exact: true }).waitFor();
    }
    return panel;
  };
  const approve = async (issue: WorkIssue, facts: WorkflowDetail) => {
    const decision = facts.decisions.find((entry) => entry.id === facts.workflow.pending_decision_id)!;
    assert.ok(decision && decision.status === "pending"); input.stage(`T013 ${facts.workflow.template_id}: ${decision.kind} human gate`);
    const panel = await refresh(issue, facts);
    await panel.getByLabel("Motivo de la decisión").fill("Reviewed the exact synthetic evidence and current bindings");
    await panel.getByLabel("Revisé esta decisión y sus bindings actuales", { exact: true }).check();
    if (decision.kind === "candidate-acceptance") {
      assert.equal(await panel.getByRole("button", { name: "Aprobar decisión exacta", exact: true }).isDisabled(), true, "acceptance requires every criterion");
      for (const criterion of (await lineage(issue.id)).issue.acceptance_criteria) await panel.getByLabel(criterion, { exact: true }).check();
    }
    const response = await observe(`/api/workflows/${facts.workflow.id}/decision`, () => panel.getByRole("button", { name: "Aprobar decisión exacta", exact: true }).click());
    assert.equal(response.status(), 200, await response.text());
    return await response.json() as WorkflowDetail;
  };
  const gate = (facts: WorkflowDetail) => facts.workflow.status === "waiting-human" && facts.decisions.some((entry) => entry.id === facts.workflow.pending_decision_id && entry.status === "pending");
  const verify = async (facts: WorkflowDetail, kinds: string[]) => {
    assert.deepEqual(facts.stages.map((stage) => stage.kind), kinds);
    const effects = (await effectLog()).filter((effect) => effect.workflow_id === facts.workflow.id);
    assert.deepEqual(effects.map((effect) => effect.kind), kinds);
    assert.equal(new Set(effects.map((effect) => effect.task_id)).size, kinds.length);
    assert.equal(new Set(effects.map((effect) => effect.execution_id)).size, kinds.length);
    assert.equal(facts.workflow.counters.tasks, kinds.length); assert.equal(facts.workflow.counters.attempts, kinds.length);
    assert.equal(facts.workflow.counters.total_tokens, kinds.length * 3); assert.equal(facts.workflow.counters.accounting_complete, true);
    for (const effect of effects) {
      const stage = facts.stages.find((entry) => entry.id === effect.stage_id)!;
      assert.equal(stage.task_id, effect.task_id); assert.equal(stage.execution_id, effect.execution_id);
      assert.equal(effect.mode, ["implementation", "correction"].includes(stage.kind) ? "workspace-write-verify" : "read-only");
      if (["implementation", "correction"].includes(stage.kind)) {
        const writer = await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${stage.task_id}`, 30_000);
        assert.equal(writer.result!.verification!.status, "passed"); assert.equal(writer.testing_evidence!.mode, facts.grant.testing_mode);
        assert.ok(writer.testing_evidence!.fingerprint); assert.equal(writer.testing_evidence!.execution_id, effect.execution_id);
        assert.deepEqual(writer.result!.files_changed, ["dashboard/src/workflow.txt"]);
      }
      if (["review", "qa"].includes(stage.kind)) {
        const receipt = facts.review_receipts.find((entry) => entry.stage_id === stage.id)!;
        assert.ok(receipt); assert.equal(receipt.candidate.candidate_id, effect.candidate_id);
        assert.equal(receipt.candidate.candidate_revision, effect.candidate_revision);
        assert.equal(receipt.context_fingerprint, (await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${stage.task_id}`)).envelope.context_manifest!.fingerprint);
      }
    }
    const encoded = JSON.stringify(facts);
    assert.ok(!encoded.includes(root) && !encoded.includes("Synthetic private project source body") && !encoded.includes("Synthetic confidential client body"), "workflow projections remain body-free");
    completed.push(facts);
  };
  {
    const issue = await create("retained-planner", input.claimRecovery ? "uncharged-claim" : "planner-recovery", true), id = await start(issue, "implementation");
    input.stage("Planner recovery: retained incomplete result and known usage");
    let facts = await wait(id, (value) => value.workflow.status === "needs-decision");
    assert.equal(facts.planner_recovery_offer?.eligible, true, "exact valid incomplete Planner is eligible");
    assert.equal(facts.workflow.counters.tasks, 1); assert.equal(facts.workflow.counters.attempts, 1); assert.equal(facts.workflow.counters.total_tokens, 3);
    assert.equal(facts.workflow.counters.accounting_complete, true); assert.equal(facts.decisions.length, 0);
    const planner = facts.stages[0]!, taskPath = join(input.stateRoot, "tasks", `${planner.task_id}.json`), eventPath = join(input.stateRoot, "events", `${planner.task_id}.jsonl`);
    const taskBytes = await readFile(taskPath), eventBytes = await readFile(eventPath), outputBefore = planner.output, chargeBefore = facts.accounting;
    const preserved = async () => {
      assert.deepEqual(await readFile(taskPath), taskBytes, "recovery never rewrites the original task");
      assert.deepEqual(await readFile(eventPath), eventBytes, "recovery never rewrites original task events");
      assert.deepEqual((await detail(id)).stages[0]!.output, outputBefore, "original needs-review output stays exact");
    };
    let panel = await refresh(issue, facts);
    const recover = panel.getByRole("region", { name: "Recuperar propuesta de Planner", exact: true });
    assert.equal(await recover.getByRole("button", { name: "Ofrecer plan para aprobación", exact: true }).isDisabled(), true);
    await recover.getByLabel("Resolución de pregunta 1").selectOption("plan-approval-gate");
    await recover.getByLabel("Respuesta a pregunta 1").fill("Keep approval pending at the separate exact-plan gate");
    await recover.getByLabel("Motivo de recuperación").fill("Offer the unchanged synthetic proposal without refund or retry");
    await recover.getByLabel(/Reconozco el riesgo:/).check();
    assert.equal(await recover.getByRole("button", { name: "Ofrecer plan para aprobación", exact: true }).isDisabled(), true);
    await recover.getByLabel("Confirmo ofrecer este plan sin cambiar alcance, límites ni verificaciones", { exact: true }).check();
    const offeredResponse = await observe(`/api/workflows/${id}/planner-recovery`, () => recover.getByRole("button", { name: "Ofrecer plan para aprobación", exact: true }).click());
    assert.equal(offeredResponse.status(), 200, await offeredResponse.text()); facts = await offeredResponse.json() as WorkflowDetail;
    assert.equal(facts.workflow.status, "waiting-human"); assert.equal(facts.stages[0]!.status, "needs-review"); assert.deepEqual(facts.accounting, chargeBefore);
    assert.equal(facts.workflow.counters.attempts, 1); assert.equal((await effectLog()).filter((entry) => entry.workflow_id === id).length, 1);
    await preserved();
    const duplicate = await post(`/api/workflows/${id}/planner-recovery`, offeredResponse.request().postDataJSON());
    assert.equal(duplicate.status, 409, "duplicate recovery cannot append another receipt or decision");
    assert.deepEqual((await detail(id)).workflow.planner_recovery, facts.workflow.planner_recovery);
    facts = await approve(issue, facts); assert.ok(facts.workflow.approved_plan);
    if (input.claimRecovery) {
      input.stage("Uncharged claim: retained failure before any Engineer executor effect");
      facts = await wait(id, (value) => value.workflow.status === "needs-decision");
      const stage = facts.stages.at(-1)!, task = await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${stage.task_id}`, 30_000);
      assert.equal(stage.kind, "implementation"); assert.equal(stage.status, "queued"); assert.equal(stage.execution_id, null);
      assert.equal(task.lifecycle, "finished"); assert.equal(task.outcome, "needs-review"); assert.equal(task.orchestration!.attempts, 1);
      assert.equal(task.envelope.metadata.run, undefined); assert.equal(task.testing_evidence, undefined); assert.equal(task.orchestration!.lease, null);
      assert.equal(facts.workflow.counters.accounting_complete, false); assert.equal(facts.workflow.counters.tasks, 2); assert.equal(facts.workflow.counters.attempts, 1);
      assert.equal((await effectLog()).filter((effect) => effect.workflow_id === id).length, 1);
      panel = await refresh(issue, facts); await panel.getByText(facts.workflow.blocked_reason!, { exact: true }).waitFor();
      const approvedPlan = facts.workflow.approved_plan, recovery = facts.workflow.planner_recovery;
      facts = await input.claimRecovery({ issue, facts, task });
      assert.deepEqual(facts.workflow.approved_plan, approvedPlan); assert.deepEqual(facts.workflow.planner_recovery, recovery);
      assert.equal(facts.workflow.uncharged_claim_recovery!.phase, "ready"); await preserved();
    }
    facts = await wait(id, gate); assert.equal(facts.decisions.find((entry) => entry.id === facts.workflow.pending_decision_id)!.kind, "candidate-acceptance");
    assert.equal((await lineage(issue.id)).issue.status, "ready-for-review");
    facts = await approve(issue, facts); facts = await detail(id);
    assert.equal(facts.workflow.status, "completed"); assert.equal(facts.stages[0]!.status, "needs-review"); assert.equal((await lineage(issue.id)).issue.status, "done");
    assert.equal(facts.review_receipts.length, 2); assert.equal(facts.stages.length, 4); await preserved();
    await verify(facts, ["planning", "implementation", "review", "qa"]);
    panel = await refresh(issue, facts);
    await panel.getByText("Recovery, intents y eventos", { exact: true }).click();
    await panel.getByRole("region", { name: "Procedencia humana del plan", exact: true }).getByText(/Planner conserva su resultado needs-review/).waitFor();
    if (input.recoveryOnly) {
      assert.equal(await harnessTreeHash(join(input.projectsRoot, workflowProjectId)), sourceBefore, "focused recovery leaves source checkout/verifier unchanged");
      assert.equal(await harnessTreeHash(join(root, "registry")), policyBefore, "focused recovery cannot change policy");
      return { records: completed, pendingIssue: issue, pendingId: id, stop, detail, effects: await effectLog() };
    }
  }
  for (const template of ["analysis", "operations-investigation"] as const) {
    const issue = await create(template), id = await start(issue, template, false, template === "analysis");
    const facts = await wait(id, gate);
    if (template === "operations-investigation") {
      const panel = await refresh(issue, facts); await panel.getByText("Etapas, roles y consentimiento aprobado", { exact: true }).click();
      await panel.getByText(/Propuesta solamente: Synthetic operations proposal/).waitFor();
      const issues = await readApiJson<{ issues: WorkIssue[] }>(`${apiUrl}/api/work-issues`);
      assert.ok(!issues.issues.some((entry) => entry.title === "Synthetic operations proposal"), "operation output cannot create an issue");
    }
    const accepted = await approve(issue, facts); assert.equal(accepted.workflow.status, "completed");
    assert.equal((await lineage(issue.id)).issue.status, "proposed", "advisory acknowledgement does not authorize or finish the issue");
    await verify(accepted, [template === "analysis" ? "analysis" : "operations"]);
  }
  const implementation = await create("implementation", "advisory", true), implementationId = await start(implementation, "implementation");
  let facts = await wait(implementationId, gate);
  assert.equal(facts.decisions.at(-1)!.kind, "plan-approval"); assert.equal(facts.stages.length, 1);
  const planEffects = await input.effects(); await delay(350); assert.deepEqual(await input.effects(), planEffects, "Planner gate cannot admit a writer");
  const planDecision = facts.decisions.find((entry) => entry.id === facts.workflow.pending_decision_id)!;
  const planApproval = { expected_revision: facts.workflow.revision, expected_issue_revision: planDecision.expected_issue_revision,
    decision_id: planDecision.id, resource_fingerprint: planDecision.resource_fingerprint, decision: "approve", confirm: true,
    approval_id: "synthetic-stale-plan-human", rationale: "Only an exact current human decision can approve this plan" };
  for (const [body, status] of [
    [{ ...planApproval, expected_revision: facts.workflow.revision - 1 }, 409],
    [{ ...planApproval, resource_fingerprint: "0".repeat(64) }, 409],
    [{ ...planApproval, confirm: false }, 400],
  ] as const) {
    assert.equal((await post(`/api/workflows/${implementationId}/decision`, body)).status, status, "obsolete, forged or unconfirmed plan authority is refused");
    assert.deepEqual(await input.effects(), planEffects, "rejected plan decisions create no writer, grant or worktree effects");
  }
  await approve(implementation, facts); facts = await wait(implementationId, gate);
  assert.equal(facts.decisions.at(-1)!.kind, "risk-acknowledgement");
  assert.equal((await lineage(implementation.id)).issue.status, "ready-for-review");
  await approve(implementation, facts); facts = await wait(implementationId, gate);
  assert.equal(facts.decisions.at(-1)!.kind, "candidate-acceptance");
  if (process.argv.includes("--fail-after-workflow-candidate")) { input.stage("injected failure after a real workflow candidate and receipts"); throw new Error("Synthetic workflow candidate failure"); }
  facts = await approve(implementation, facts); assert.equal((await lineage(implementation.id)).issue.status, "done");
  await verify(facts, ["planning", "implementation", "review", "qa"]);

  const trivial = await create("trivial-and-quality", "approve", true);
  assert.equal(trivial.work_scale, "trivial"); const trivialId = await start(trivial, "trivial-change");
  facts = await wait(trivialId, gate); assert.equal(facts.decisions.at(-1)!.kind, "candidate-acceptance");
  assert.equal(facts.workflow.review_policy!.effective_depth, "full"); assert.equal(facts.workflow.review_policy!.qa_required, true);
  await verify(facts, ["implementation", "review", "qa"]);
  async function stop(issue: WorkIssue, facts: WorkflowDetail) {
    const panel = await refresh(issue, facts); await panel.getByLabel(/Confirmo detener este workflow/).check();
    const response = await observe(`/api/workflows/${facts.workflow.id}/cancel`, () => panel.getByRole("button", { name: "Detener workflow", exact: true }).click());
    assert.equal(response.status(), 200, await response.text()); return wait(facts.workflow.id, (value) => value.workflow.status === "cancelled");
  }
  const retainedCandidate = facts.workflow.candidate!; completed[completed.length - 1] = await stop(trivial, facts);
  const qualityIssue = (await lineage(trivial.id)).issue;
  assert.equal(qualityIssue.status, "ready-for-review"); const qualityId = await start(qualityIssue, "quality-review");
  facts = await wait(qualityId, gate); assert.deepEqual(facts.workflow.candidate, retainedCandidate);
  assert.equal(facts.grant.correction.enabled, false);
  const decision = facts.decisions.at(-1)!;
  const beforeInvalid = await input.effects();
  const stale = await post(`/api/workflows/${qualityId}/decision`, { expected_revision: facts.workflow.revision - 1, expected_issue_revision: decision.expected_issue_revision,
    decision_id: decision.id, resource_fingerprint: decision.resource_fingerprint, decision: "approve", confirm: true,
    approval_id: "synthetic-stale-acceptance", rationale: "Must not bypass exact candidate criteria", confirmed_criteria: qualityIssue.acceptance_criteria });
  assert.equal(stale.status, 409); assert.deepEqual(await input.effects(), beforeInvalid);
  const writer = await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${retainedCandidate.task_id}`);
  const candidatePath = (writer.envelope.metadata.run as { worktree_path: string }).worktree_path;
  assert.ok(isInside(join(input.projectsRoot, "surtec-worktrees"), candidatePath));
  const changedPath = join(candidatePath, "dashboard/src/workflow.txt"), originalBytes = await readFile(changedPath);
  await writeFile(changedPath, "Synthetic unsealed physical mutation.\n");
  const changedEffects = await input.effects();
  const changed = await post(`/api/workflows/${qualityId}/decision`, { expected_revision: facts.workflow.revision, expected_issue_revision: decision.expected_issue_revision,
    decision_id: decision.id, resource_fingerprint: decision.resource_fingerprint, decision: "approve", confirm: true,
    approval_id: "synthetic-mutated-tree", rationale: "Must not accept an unsealed physical candidate", confirmed_criteria: qualityIssue.acceptance_criteria });
  assert.equal(changed.status, 409); assert.deepEqual(await input.effects(), changedEffects);
  await writeFile(changedPath, originalBytes); facts = await approve(qualityIssue, await detail(qualityId));
  assert.equal((await lineage(trivial.id)).issue.status, "done"); await verify(facts, ["review", "qa"]);

  for (const scenario of ["correction", "repeat-correction"]) {
    const issue = await create(scenario, scenario, true), id = await start(issue, "implementation", true);
    await approve(issue, await wait(id, gate));
    if (scenario === "repeat-correction") {
      input.stage("T013 repeat-correction: one consumed allowance and exact second-correction refusal");
      // Six post-Planner roles include two full candidate inspection/review
      // cycles. Bound this campaign's wall time separately from active-runtime
      // caps, HTTP deadlines and every shorter gate's existing deadline.
      const deadline = Date.now() + 180_000;
      await closeWorkflowPanels(page);
      facts = await detail(id);
      while (facts.workflow.status !== "needs-decision" && Date.now() < deadline) { await delay(250); facts = await detail(id); }
      assert.equal(facts.workflow.status, "needs-decision"); assert.equal(facts.stages.filter((stage) => stage.kind === "correction").length, 1);
      assert.ok(facts.workflow.blocked_reason?.includes("single correction"), `only exhausted correction may block this scenario: ${facts.workflow.blocked_reason}`);
      const panel = await refresh(issue, facts);
      // Workflow and issue intentionally share needs-decision after an exact
      // budget stop. Assert both semantic fields without an ambiguous match.
      await panel.locator(".workflow-facts dt").filter({ hasText: /^Template$/ }).locator("xpath=following-sibling::dd[1]")
        .filter({ hasText: /needs-decision/ }).waitFor();
      await panel.locator(".workflow-facts dt").filter({ hasText: /^Issue$/ }).locator("xpath=following-sibling::dd[1]")
        .filter({ hasText: /^needs-decision ·/ }).waitFor();
      assert.equal(await panel.getByRole("button", { name: "Aprobar decisión exacta" }).count(), 0);
    } else {
      facts = await wait(id, gate, 180_000); assert.equal(facts.decisions.at(-1)!.kind, "candidate-acceptance");
      input.stage("T013 correction: exact candidate evidence, mobile layout and owned task navigation");
      const panel = await refresh(issue, facts);
      for (const summary of ["Etapas, roles y consentimiento aprobado", /^Handoffs completados/, /^Evidencia, verificación y receipts/, "Recovery, intents y eventos"]) {
        const control = panel.getByText(summary, { exact: typeof summary === "string" });
        if (!await control.evaluate((element) => (element.closest("details") as HTMLDetailsElement).open)) await control.click();
      }
      await panel.getByText(`Receipt de testing · ${facts.grant.testing_mode}`, { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "full workflow evidence wraps on mobile");
      await page.setViewportSize({ width: 1440, height: 1000 });
      const ownedTask = facts.stages.at(-1)!.task_id!;
      const taskLink = panel.getByRole("button", { name: `Ver tarea ${ownedTask}`, exact: true });
      await taskLink.waitFor({ state: "visible" }); await taskLink.click();
      await page.getByRole("region", { name: "Workflow propietario", exact: true }).getByText(`${id} · ${issue.id}`, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Abrir workflow del issue", exact: true }).click();
      await page.getByRole("region", { name: `Workflow de ${issue.title}`, exact: true }).waitFor();
      facts = await approve(issue, await detail(id)); assert.equal((await lineage(issue.id)).issue.status, "done");
    }
    assert.equal(facts.lineage!.corrections_consumed, 1); assert.equal(facts.lineage!.candidate_ids.length, 2);
    const entries = (await lineage(issue.id)).candidates, prior = entries.find((entry) => entry.id === facts.lineage!.candidate_ids[0])!, corrected = entries.find((entry) => entry.id === facts.lineage!.candidate_ids[1])!;
    assert.equal(corrected.base_revision, prior.candidate_revision); assert.notEqual(corrected.diff_fingerprint, prior.diff_fingerprint);
    assert.ok(prior.invalidated_at); assert.equal(facts.review_receipts.length, 4);
    await verify(facts, ["planning", "implementation", "review", "qa", "correction", "review", "qa"]);
  }
  const heldIssue = await create("held-stop", "hold"), heldId = await start(heldIssue, "analysis");
  input.stage("T013 held-stop: durable cancellation of an invoked read-only role");
  facts = await wait(heldId, (value) => value.stages[0]!.status === "running" && value.workflow.counters.attempts === 1);
  const heldDeadline = Date.now() + 10_000;
  while (!(await effectLog()).some((entry) => entry.workflow_id === heldId && entry.stage_id === facts.stages[0]!.id && entry.execution_id === facts.stages[0]!.execution_id) && Date.now() < heldDeadline) await delay(100);
  assert.ok((await effectLog()).some((entry) => entry.workflow_id === heldId && entry.task_id === facts.stages[0]!.task_id), "stop targets an actually invoked held role");
  const stopped = await stop(heldIssue, await detail(heldId)), stoppedTask = await waitForTask(apiUrl, stopped.stages[0]!.task_id!);
  assert.equal(stoppedTask.outcome, "cancelled"); assert.equal(stopped.stages.length, 1);
  const stoppedFacts = await detail(heldId);
  assert.equal(stoppedFacts.workflow.counters.accounting_complete, false, "interrupted unknown usage is never accounted as complete zero");
  assert.equal(stoppedFacts.accounting[0]!.usage_complete, false);
  assert.equal((await lineage(heldIssue.id)).issue.status, "proposed"); completed.push(stoppedFacts);
  const pendingIssue = await create("pending-plan-restart", "approve", true), pendingId = await start(pendingIssue, "implementation");
  const pending = await wait(pendingId, gate); assert.equal(pending.stages.length, 1); assert.equal(pending.decisions.at(-1)!.kind, "plan-approval");
  assert.equal(await harnessTreeHash(join(input.projectsRoot, workflowProjectId)), sourceBefore, "source checkout and protected verifier bytes never change");
  assert.equal(await harnessTreeHash(join(root, "registry")), policyBefore, "workflow execution cannot change trusted policy or allowlists");
  completed.push(pending); input.stage("T013 all five templates, bounded correction and durable gates completed");
  // Do not carry a workflow panel's pending reads into the ordinary 10-second
  // restart capture. Closing it prevents new reads; finish existing ones within
  // this campaign's unchanged 30-second drain, without cancelling or excluding them.
  input.stage("T013 close workflow panels and settle existing campaign reads");
  await settleWorkflowPanels(page, input.drainReads);
  input.stage("T013 workflow reads settled before durable restart capture");
  // Quality-review legitimately appends its owner to the retained candidate's
  // shared lineage. Capture the complete final read models after that action,
  // rather than comparing an earlier lineage snapshot to the post-restart one.
  // All owners are at durable gates. Observe their independent final views
  // together, preserving input order and propagating any failed read.
  const records = await Promise.all(completed.map((record) => detail(record.workflow.id)));
  return { records, pendingIssue, pendingId, stop, detail, effects: await effectLog() };
}

async function main(): Promise<void> {
  let stage = "allocate isolated workspace";
  let api: ApiProcess | null = null;
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let reads: ReturnType<typeof trackBrowserApiReads> | null = null;
  const budgetProxyTrace = createBudgetProxyTrace();
  let tempRoot: string | null = null;

  try {
    tempRoot = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-"));
    assert.ok(isInside(tmpdir(), tempRoot), "test-owned workspace is a child of the OS temp directory");
    const stateRoot = join(tempRoot, "state");
    const projectsRoot = join(tempRoot, "projects");
    await mkdir(join(stateRoot, "portfolio"), { recursive: true });
    await mkdir(projectsRoot, { recursive: true });
    const port = await reserveLoopbackPort();
    const apiUrl = `http://127.0.0.1:${port}`;
    const environment = isolatedApiEnvironment(port, stateRoot, projectsRoot);

    stage = "create synthetic repositories and legacy profile document";
    await createSyntheticGitProject(projectsRoot, profileProjectId, environment);
    await createSyntheticGitProject(projectsRoot, profileClientId, environment);
    await createSyntheticGitProject(projectsRoot, issueProjectId, environment);
    await createSyntheticGitProject(projectsRoot, workflowProjectId, environment);
    // Privileged registry and Git identity belong only to this disposable fixture.
    await mkdir(join(tempRoot, "registry"), { recursive: true });
    for (const source of ["registry/agents.yml", "registry/agent-roles.yml", "registry/context-policy.yml", "registry/workflow-policy.yml", "evals"]) await cp(join(repoRoot, source), join(tempRoot, source), { recursive: true });
    const contextConfig = parse(await readFile(join(tempRoot, "registry/context-policy.yml"), "utf8"));
    contextConfig.routes = [{ id: "synthetic-required-source", role_ids: [], task_kinds: [], affected_domains: [], paths: ["docs/smoke-context.md"], required: true }];
    // Synthetic trusted floor exercises QA even for a classified trivial issue.
    contextConfig.testing.projects[workflowProjectId] = { mode: "functional", minimum_review_depth: "full", runner_ids: [] };
    await writeFile(join(tempRoot, "registry/context-policy.yml"), stringify(contextConfig));
    await writeFile(join(tempRoot, "registry", "projects.yml"), `projects:\n  ${profileProjectId}:\n    status: active\n    allowed_agents: [tech-lead, frontend-engineer]\n  ${profileClientId}:\n    status: active\n    allowed_agents: [tech-lead, frontend-engineer]\n  ${issueProjectId}:\n    allowed_agents: [frontend-engineer, tech-lead]\n    sandbox:\n      default: workspace-write\n    commands:\n      test: node --version\n  ${workflowProjectId}:\n    allowed_agents: [product-manager, frontend-engineer, tech-lead, reality-checker, qa-reviewer, devops-engineer]\n    sandbox: { default: workspace-write }\n    verify: ['node verify-workflow.mjs']\n`);
    // Explicit synthetic canonical source and project scaffolds; only reviewed public files.
    const canonicalRoot = join(tempRoot, "canonical");
    for (const destination of [canonicalRoot, join(projectsRoot, profileProjectId), join(projectsRoot, profileClientId)]) {
      await mkdir(destination, { recursive: true });
      await materializeReviewedHarnessFixture(repoRoot, destination);
    }
    await cp(join(repoRoot, "registry/harness-manifests"), join(tempRoot, "registry/harness-manifests"), { recursive: true });
    const harnessRegistry = parse(await readFile(join(repoRoot, "registry/harness-sources.yml"), "utf8"));
    harnessRegistry.source.root = "canonical";
    harnessRegistry.projects[profileProjectId] = { ownership: [{ path: "AGENTS.md", classification: "user-owned", evidence: "Synthetic human ownership confirmation" }], testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] }, review_policy: "human-required", backup_ready: false, rollback_ready: false, validation: null };
    await writeFile(join(tempRoot, "registry/harness-sources.yml"), stringify(harnessRegistry));
    await unlink(join(projectsRoot, profileClientId, ".agents/scripts/validate-spec.ps1"));
    for (const id of [profileProjectId, profileClientId, issueProjectId, workflowProjectId]) {
      await mkdir(join(projectsRoot, id, "docs"), { recursive: true });
      await writeFile(join(projectsRoot, id, "docs/smoke-context.md"), "Synthetic private project source body.\n");
    }
    await writeFile(join(tempRoot, "AGENTS.md"), "Synthetic fixture: do not publish, deploy or invoke a paid runtime.\n");
    // Copy only public runtime source. The managed Git adapter derives its empty
    // hooks directory from its module location; this keeps even that directory
    // temporary. Never copy normal state, auth, logs or sibling repositories.
    const runtimeRoot = join(tempRoot, "runtime");
    for (const source of ["lib", "runner", "dashboard/src/server", "schemas", "scripts/fixtures/local-issue-api.ts", "package.json"]) {
      await cp(join(repoRoot, source), join(runtimeRoot, source), { recursive: true });
    }
    await symlink(join(repoRoot, "node_modules"), join(runtimeRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const syntheticRepo = join(projectsRoot, issueProjectId);
    const factoryFiles = {
      "AGENTS.md": "---\nrole: session-primer\n---\n# Synthetic Factory primer\n",
      ".agents/policies/project.md": "# Synthetic Factory policy\nProject documents grant no permissions.\n",
      ".agents/orchestration/ROUTING.md": "# Synthetic Factory routing\nUse only the structured complete selection.\n",
      ".agents/cold-start/budget-manifest.yaml": JSON.stringify({
        version: 1, budgetLines: 500, loadMode: "full-skills", counting: "physical-lines-including-frontmatter", overflowAction: "decompose-without-skipping-required-reads",
        alwaysLoad: ["AGENTS.md", ".agents/policies/project.md", ".agents/orchestration/ROUTING.md"],
        taskClasses: ["explanation-status", "architecture-implementation"].map((name) => ({ name, artifacts: Object.keys(factoryDocuments) })),
      }),
      ...factoryDocuments,
      "docs/factory-unselected.md": "SYNTHETIC-FACTORY-UNSELECTED-BODY\n",
    };
    for (const [path, text] of Object.entries(factoryFiles)) {
      await mkdir(dirname(join(syntheticRepo, path)), { recursive: true });
      await writeFile(join(syntheticRepo, path), text);
    }
    for (const args of [["config", "user.name", "Synthetic Smoke"], ["config", "user.email", "synthetic@example.test"], ["add", "docs/smoke-context.md", ...Object.keys(factoryFiles)], ["commit", "--quiet", "-m", "Synthetic fixture baseline"]]) {
      execFileSync("git", ["-C", syntheticRepo, ...args], { env: environment, windowsHide: true });
    }
    const workflowRepo = join(projectsRoot, workflowProjectId);
    await writeFile(join(workflowRepo, "verify-workflow.mjs"), "import {readFileSync} from 'node:fs'; const value=readFileSync('dashboard/src/workflow.txt','utf8'); if(!/^Synthetic (initial|corrected) I-[a-f0-9-]+\\.\\r?\\n$/.test(value)) process.exit(1); console.log('Synthetic bounded workflow result verified');\n");
    for (const args of [["config", "user.name", "Synthetic Smoke"], ["config", "user.email", "synthetic@example.test"], ["add", "docs/smoke-context.md", "verify-workflow.mjs"], ["commit", "--quiet", "-m", "Synthetic workflow baseline"]]) execFileSync("git", ["-C", workflowRepo, ...args], { env: environment, windowsHide: true });
    const workflowBaseline = execFileSync("git", ["-C", workflowRepo, "rev-parse", "HEAD"], { env: environment, encoding: "utf8", windowsHide: true }).trim();
    const legacyProfiles = {
      schema_version: 1,
      projects: {
        [profileProjectId]: v1Profile(profileProjectId, "personal"),
        [profileClientId]: v1Profile(profileClientId, "client"),
      },
    };
    const legacyProfileBytes = Buffer.from(`${JSON.stringify(legacyProfiles, null, 2)}\n`, "utf8");
    const profilesPath = join(stateRoot, "portfolio", "projects.json");
    await writeFile(profilesPath, legacyProfileBytes, { flag: "wx", mode: 0o600 });
    const syntheticClient = { id: syntheticClientId, display_name: "Synthetic private client identity", status: "active", criticality: "low", sla_note: "Synthetic service policy", next_review_date: null, confidential_notes: "Synthetic confidential client body", created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z" };
    await writeFile(join(stateRoot, "portfolio/clients.json"), JSON.stringify({ schema_version: 1, clients: { [syntheticClientId]: syntheticClient }, commitments: {} }));

    stage = "start real local API and Vite dashboard";
    api = startApi(port, stateRoot, projectsRoot);
    await waitForApi(api, apiUrl);
    const unauthorizedWrite = await fetch(`${apiUrl}/api/organization/company`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(unauthorizedWrite.status, 403, "local API rejects a write without its in-memory session token");

    stage = "migrate legacy portfolio profiles and verify the backup";
    const migrationResponse = await fetch(`${apiUrl}/api/portfolio/profiles`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(migrationResponse.status, 200, "legacy portfolio migration endpoint returns 200");
    const migrationPayload = await migrationResponse.json() as { profiles?: MigratedProfile[]; migration?: MigrationReport | null };
    assert.equal(migrationPayload.profiles?.length, 2, "both legacy profiles are returned after migration");
    assert.equal(migrationPayload.migration?.migration, "portfolio-profiles-v1-to-v2");
    assert.equal(migrationPayload.migration?.project_count, 2);
    assert.equal(migrationPayload.migration?.client_categories_migrated, 1);
    assert.equal(migrationPayload.migration?.personal_categories_preserved, 1);
    assert.equal(migrationPayload.migration?.source_sha256, createHash("sha256").update(legacyProfileBytes).digest("hex"));
    assert.match(migrationPayload.migration?.backup_id ?? "", /^[a-f0-9]{64}\.v1\.json$/);
    const backupPath = join(stateRoot, "backups", "phase-k-portfolio-profiles", migrationPayload.migration!.backup_id);
    assert.ok(isInside(tempRoot, backupPath), "migration backup remains inside test-owned temp state");
    assert.deepEqual(await readFile(backupPath), legacyProfileBytes, "migration backup preserves the exact source bytes");
    const migratedDiskDocument = JSON.parse(await readFile(profilesPath, "utf8")) as { schema_version?: number; projects?: Record<string, MigratedProfile> };
    assert.equal(migratedDiskDocument.schema_version, 2, "legacy portfolio document was migrated on disk");
    assert.equal(migratedDiskDocument.projects?.[profileProjectId]?.kind, "personal", "personal category is preserved");
    assert.equal(migratedDiskDocument.projects?.[profileClientId]?.kind, "client-product", "legacy client category maps to client-product");
    assert.equal(migratedDiskDocument.projects?.[profileClientId]?.client_id, syntheticClientId, "client association is preserved");

    const vitePort = await reserveLoopbackPort();
    vite = await createServer({
      configFile: join(repoRoot, "vite.config.ts"),
      plugins: [{ name: "synthetic-budget-read-trace", configureServer(server) {
        server.middlewares.use((request, _response, next) => { budgetProxyTrace.observe("received", request); next(); });
      } }],
      server: {
        host: "127.0.0.1",
        port: vitePort,
        strictPort: true,
        proxy: { "/api": { target: apiUrl, configure(proxy) {
          proxy.on("proxyReq", (_outgoing, request) => budgetProxyTrace.observe("forwarded", request));
          proxy.on("proxyRes", (upstream, request) => {
            if (!isBudgetGet(request.method, request.url)) return;
            budgetProxyTrace.observe("upstream_headers", request);
            upstream.once("end", () => budgetProxyTrace.observe("upstream_finished", request));
          });
        } } },
      },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite server has a loopback TCP address");
    assert.equal((address as AddressInfo).port, vitePort, "Vite is bound to its reserved temporary port, not the default UI port");
    const dashboardUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

    stage = "migrate legacy portfolio profiles in the real browser flow";
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    reads = trackBrowserApiReads(page.context());
    const browserErrors: string[] = [];
    const browserHttpErrors: string[] = [];
    const mutatingSessionHeaders: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(`${message.text()} (${message.location().url || "unknown source"})`); });
    page.on("response", (response) => {
      if (response.status() >= 400) browserHttpErrors.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if ((url.pathname.startsWith("/api/organization/") || url.pathname.startsWith("/api/work-issues") || url.pathname.startsWith("/api/workflows")) && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        mutatingSessionHeaders.push(request.headers()["x-surtec-session"] ?? "");
      }
    });

    await reads.navigate(() => page.goto(`${dashboardUrl}/`, { waitUntil: "domcontentloaded" }));
    await page.getByText("Cockpit diario").waitFor();
    await page.getByText("En vivo", { exact: true }).waitFor();
    // A focused actual API/browser selection, never a substitute for the full
    // compatibility campaign below. Both paths use the same history assertions.
    if (process.argv.includes("--history-restart-only")) {
      stage = "F4 T004 focused history before restart";
      const fixture = await prepareHistoryFixture(stateRoot, { project: profileProjectId, agent: "frontend-engineer", repo_path: join(projectsRoot, profileProjectId) });
      const detailUrl = `${apiUrl}/api/tasks/${fixture.historyTaskId}/detail`;
      const before = await readApiJson<import("../lib/state/types").TaskDetailModel>(detailUrl);
      assert.deepEqual(before.task, fixture.historyTask);
      assert.deepEqual(before.events.map((event) => event.revision), [1], "detail never invents a missing event");
      const openHistory = async () => {
        await page.getByRole("button", { name: "Overview", exact: true }).click();
        await page.locator(".hist-row").getByRole("button", { name: fixture.historyTaskId, exact: true }).click();
        await assertRecordedHistory(page, fixture);
      };
      await openHistory();
      const sessionBefore = await readApiJson<{ token: string }>(`${apiUrl}/api/session`);
      await reads.navigate(() => page.goto("about:blank"));
      assert.equal(await stopApi(api), true, "focused API stops before restart");
      api = null;
      await delay(250);
      api = startApi(port, stateRoot, projectsRoot);
      await waitForApi(api, apiUrl);
      const sessionAfter = await readApiJson<{ token: string }>(`${apiUrl}/api/session`);
      assert.notEqual(sessionAfter.token, sessionBefore.token, "focused restart rotates process-local session authority");
      stage = "F4 T004 focused history after real API restart and reload";
      await reads.navigate(() => page.goto(`${dashboardUrl}/`, { waitUntil: "domcontentloaded" }));
      await page.getByText("Cockpit diario").waitFor();
      await openHistory();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "history observation has no mobile overflow");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await reads.navigate(() => page.reload({ waitUntil: "domcontentloaded" }));
      await page.getByText("Cockpit diario").waitFor();
      await openHistory();
      assert.deepEqual(await readApiJson(detailUrl), before, "new process reconstructs saved facts without inventing history");
      const effects = await readFile(join(tempRoot, "executor-effects.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      assert.equal(effects, "", "focused restart never executes or replays any task");
      assert.deepEqual(browserErrors, []); assert.deepEqual(browserHttpErrors, []);
      console.log("PASS focused F4 T004 actual API + Chromium: authoritative snapshot/partial history, restart, session rotation, reload, mobile layout, byte preservation; zero synthetic or paid turns. Full compatibility campaign not selected.");
      return;
    }
    if (process.argv.includes("--uncharged-claim-recovery-only")) {
      stage = "focused uncharged claim actual API/browser";
      let sessionToken = (await readApiJson<{ token: string }>(apiUrl + "/api/session")).token;
      const focusedPost = (path: string, body: unknown) => observeNodeApi("POST", apiUrl + path, 30_000, "response", () => fetch(apiUrl + path, {
        method: "POST", headers: { "content-type": "application/json", "x-surtec-session": sessionToken },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      }));
      const focusedEffects = () => reads!.snapshot(async () => ({ state: await harnessTreeHash(stateRoot, ["locks/orchestrator-schedule.lock", "maintenance/boundary.lock"]),
        worktrees: await hashOrAbsent(join(projectsRoot, "surtec-worktrees")), executor: await readFile(join(tempRoot!, "executor-effects.jsonl"), "utf8")
          .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return "absent"; }) }), 30_000, "unlabelled");
      let retainedTaskId = "", retainedRunId = "";
      const recovered = await workflowCampaign({ page, apiUrl, dashboardUrl, root: tempRoot, stateRoot, projectsRoot, recoveryOnly: true,
        post: focusedPost, effects: focusedEffects, drainReads: () => reads!.drain(30_000), stage: (value) => { stage = value; console.log(value); },
        claimRecovery: async ({ facts, task }) => {
          retainedTaskId = task.envelope.id; retainedRunId = task.orchestration!.last_failure!.run_id;
          await settleWorkflowPanels(page, () => reads!.drain(30_000));
          await reads!.navigate(() => page.goto("about:blank"));
          assert.ok(api);
          await requestUnchargedFixture(api.child, { kind: "seal-uncharged-claim", workflow_id: facts.workflow.id,
            expected_revision: facts.workflow.revision, expected_task_revision: task.revision! });
          const native = await awaitUnchargedFixtureClosure(api);
          assert.equal(native.native_exit, 2); assert.equal(native.native_signal, null);
          assert.equal(native.root_exit_observed, true); assert.equal(native.stdout_eof, true); assert.equal(native.stderr_eof, true);
          assert.equal(native.termination_requested, false); assert.equal(native.capture_truncated, false);
          assert.equal(native.spawn_error, null); assert.equal(native.stream_error, null);
          api = null;
          const archive = join(tempRoot!, "claim-recovery-archive"); await mkdir(archive);
          for (const [source, target] of [
            ["workflows/workflows.json", "workflows.json"], ["tasks/" + task.envelope.id + ".json", "task.json"],
            ["events/" + task.envelope.id + ".jsonl", "events.jsonl"], ["issues/issues.json", "issues.json"],
          ]) await cp(join(stateRoot, source), join(archive, target));
          await cp(join(tempRoot!, "runtime/scripts/fixtures/local-issue-api.ts"), join(archive, "operator.mjs"));
          await writeFile(join(archive, "native.json"), JSON.stringify(native));
          const initialTaskBytes = await readFile(join(archive, "task.json")), initialEventBytes = await readFile(join(archive, "events.jsonl"));
          const effectsBefore = await readFile(join(tempRoot!, "executor-effects.jsonl"));
          api = startApi(port, stateRoot, projectsRoot); await waitForApi(api, apiUrl);
          sessionToken = (await readApiJson<{ token: string }>(apiUrl + "/api/session")).token;
          assert.deepEqual(await readApiJson(apiUrl + "/api/workflows/" + facts.workflow.id, 30_000), facts, "restart never automatically recovers the uncharged task");
          const reply = await requestUnchargedFixture(api.child, { kind: "recover-uncharged-claim", workflow_id: facts.workflow.id,
            expected_revision: facts.workflow.revision, expected_task_revision: task.revision! });
          assert.equal(reply.phase, "ready"); assert.equal(reply.worker_started, false);
          const ready = await readApiJson<WorkflowDetail>(apiUrl + "/api/workflows/" + facts.workflow.id, 30_000);
          const queued = await readApiJson<TaskRecord>(apiUrl + "/api/tasks/" + task.envelope.id, 30_000);
          assert.equal(queued.lifecycle, "queued"); assert.equal(queued.orchestration!.attempts, 1);
          assert.equal(queued.revision, task.revision! + 1); assert.deepEqual(queued.envelope, task.envelope);
          assert.deepEqual(ready.workflow.counters, { ...facts.workflow.counters, accounting_complete: true });
          assert.deepEqual(ready.accounting, facts.accounting); assert.deepEqual(ready.workflow.budget, facts.workflow.budget);
          assert.deepEqual(await readFile(join(archive, "task.json")), initialTaskBytes);
          assert.deepEqual((await readFile(join(stateRoot, "events", task.envelope.id + ".jsonl"))).subarray(0, initialEventBytes.length), initialEventBytes);
          const duplicate = await requestUnchargedFixture(api.child, { kind: "recover-uncharged-claim", workflow_id: facts.workflow.id,
            expected_revision: ready.workflow.revision, expected_task_revision: queued.revision! }).then(() => false, () => true);
          assert.equal(duplicate, true, "one-use recovery refuses replay");
          assert.deepEqual(await readFile(join(tempRoot!, "executor-effects.jsonl")), effectsBefore, "recovery itself cannot start a role");
          assert.deepEqual(await readApiJson(apiUrl + "/api/workflows/" + facts.workflow.id, 30_000), ready);
          await reads!.navigate(() => page.goto(dashboardUrl + "/", { waitUntil: "domcontentloaded" }));
          await page.getByText("Cockpit diario").waitFor();
          await requestUnchargedFixture(api.child, { kind: "start-recovered-claim", workflow_id: facts.workflow.id,
            expected_revision: ready.workflow.revision, expected_task_revision: queued.revision! });
          return ready;
        } });
      assert.equal(recovered.effects.length, 4, "exactly four role executions, never an executor effect for the failed claim");
      const before = await readApiJson<WorkflowDetail>(apiUrl + "/api/workflows/" + recovered.pendingId, 30_000);
      const writer = await readApiJson<TaskRecord>(apiUrl + "/api/tasks/" + retainedTaskId, 30_000);
      assert.equal(writer.orchestration!.attempts, 2); assert.equal(writer.outcome, "completed");
      assert.equal(before.workflow.counters.tasks, 4); assert.equal(before.workflow.counters.attempts, 4);
      assert.equal(before.workflow.uncharged_claim_recovery!.original_run_id, retainedRunId);
      assert.equal(before.workflow.uncharged_claim_recovery!.phase, "ready");
      assert.ok(!before.accounting.some((row) => row.execution_id === retainedRunId));
      assert.equal(before.accounting.find((row) => row.task_id === retainedTaskId)!.attempt, 2);
      const effectsBefore = await readFile(join(tempRoot, "executor-effects.jsonl"));
      await reads.navigate(() => page.goto("about:blank"));
      assert.equal(await stopApi(api!), true); api = null; await delay(250);
      api = startApi(port, stateRoot, projectsRoot); await waitForApi(api, apiUrl);
      assert.deepEqual(await readApiJson(apiUrl + "/api/workflows/" + recovered.pendingId, 30_000), before);
      await reads.navigate(() => page.goto(dashboardUrl + "/", { waitUntil: "domcontentloaded" }));
      await page.getByRole("button", { name: "Issues", exact: true }).click();
      const card = page.locator("article.work-issue-card").filter({ hasText: recovered.pendingIssue.title });
      await card.getByRole("button", { name: "Ver workflow", exact: true }).click();
      const panel = card.getByRole("region", { name: "Workflow de " + recovered.pendingIssue.title });
      await panel.getByText("Recovery, intents y eventos", { exact: true }).click();
      const recoverySummary = "One uncharged claim recovered; original claim retained and current execution guards still apply.";
      const recoveryEvent = before.events.find((entry) => entry.type === "reconciled" && entry.summary === recoverySummary);
      assert.ok(recoveryEvent, "restart retains the exact recovery event");
      await panel.getByText(`r${recoveryEvent.revision} · ${recoveryEvent.type} · ${recoverySummary}`, { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await readFile(join(tempRoot, "executor-effects.jsonl")), effectsBefore, "completed recovery never replays on actual restart");
      assert.deepEqual(browserErrors, []); assert.deepEqual(browserHttpErrors, []);
      console.log("PASS focused uncharged claim actual API + Chromium: real closed producer/EOFs, same task and retained claim, separate stopped-worker recovery/start, unchanged caps and Planner, four fake charged roles, exact verified candidate/reviews, human criteria, restart/no replay and mobile evidence; no paid calls.");
      return;
    }

    if (process.argv.includes("--planner-recovery-only")) {
      stage = "focused Planner recovery actual API/browser";
      const focusedSession = await readApiJson<{ token: string }>(`${apiUrl}/api/session`);
      const focusedPost = (path: string, body: unknown) => observeNodeApi("POST", `${apiUrl}${path}`, 30_000, "response", () => fetch(`${apiUrl}${path}`, {
        method: "POST", headers: { "content-type": "application/json", "x-surtec-session": focusedSession.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      }));
      const focusedEffects = () => reads!.snapshot(async () => ({ state: await harnessTreeHash(stateRoot, ["locks/orchestrator-schedule.lock", "maintenance/boundary.lock"]),
        worktrees: await hashOrAbsent(join(projectsRoot, "surtec-worktrees")), executor: await readFile(join(tempRoot!, "executor-effects.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return "absent"; }) }), 30_000, "unlabelled");
      const recovered = await workflowCampaign({ page, apiUrl, dashboardUrl, root: tempRoot, stateRoot, projectsRoot, recoveryOnly: true,
        post: focusedPost, effects: focusedEffects, drainReads: () => reads!.drain(30_000), stage: (value) => { stage = value; console.log(value); } });
      assert.equal(recovered.effects.length, 4, "focused recovery uses exactly four fake roles");
      const before = await readApiJson<WorkflowDetail>(`${apiUrl}/api/workflows/${recovered.pendingId}`, 30_000);
      const effectsBefore = await readFile(join(tempRoot, "executor-effects.jsonl"));
      await reads.navigate(() => page.goto("about:blank"));
      assert.equal(await stopApi(api), true, "focused recovery API stops before restart"); api = null; await delay(250);
      api = startApi(port, stateRoot, projectsRoot); await waitForApi(api, apiUrl);
      assert.deepEqual(await readApiJson(`${apiUrl}/api/workflows/${recovered.pendingId}`, 30_000), before, "recovery provenance persists across actual API restart");
      await reads.navigate(() => page.goto(`${dashboardUrl}/`, { waitUntil: "domcontentloaded" }));
      await page.getByRole("button", { name: "Issues", exact: true }).click();
      const card = page.locator("article.work-issue-card").filter({ hasText: recovered.pendingIssue.title });
      await card.getByRole("button", { name: "Ver workflow", exact: true }).click();
      const panel = card.getByRole("region", { name: `Workflow de ${recovered.pendingIssue.title}` });
      await panel.getByText("Recovery, intents y eventos", { exact: true }).click();
      await panel.getByRole("region", { name: "Procedencia humana del plan", exact: true }).getByText(/Planner conserva su resultado needs-review/).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "recovery evidence fits mobile layout");
      assert.deepEqual(await readFile(join(tempRoot, "executor-effects.jsonl")), effectsBefore, "restart never replays a role");
      assert.deepEqual(browserErrors, []); assert.deepEqual(browserHttpErrors, []);
      console.log("PASS focused Planner recovery actual API + Chromium: unchanged task/events/output/charges, distinct human gates, four fake roles, exact verified candidate and independent reviews, local acceptance, restart/no replay, mobile evidence; no paid calls.");
      return;
    }
    if (process.argv.includes("--fail-after-browser")) {
      stage = "injected rejected browser action";
      await observeResponse(page, "/api/synthetic-never-sent", "POST", async () => { throw new Error("Synthetic browser action failure"); });
    }

    stage = "save company profile and objectives from the dashboard";
    await page.getByRole("button", { name: "SURTEC", exact: true }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();
    await page.getByLabel("Nombre visible").fill("SURTEC");
    await page.getByLabel("Misión").fill("Synthetic local acceptance mission.");
    await page.getByLabel("Principios operativos").fill("Keep local test data isolated.\nPreserve source records.");
    assert.equal(await page.locator(".organization-company-form").evaluate((element) => (element as HTMLFormElement).checkValidity()), true, "synthetic company form is valid before expecting its PUT request");
    const profileSave = await observeResponse(page, "/api/organization/company", "PUT", () => page.getByRole("button", { name: "Guardar perfil", exact: true }).click());
    assert.equal(profileSave.status(), 200, "company profile UI write returns 200");
    await page.getByText("Perfil SURTEC guardado localmente.", { exact: true }).waitFor();

    const futureDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const activeObjective = await createObjective(page, { title: "Synthetic active objective", status: "active", date: futureDate });
    const pausedObjective = await createObjective(page, { title: "Synthetic paused objective", status: "paused", date: null });
    const achievedObjective = await createObjective(page, { title: "Synthetic achieved objective", status: "achieved", date: null });
    assert.equal(typeof activeObjective.id, "string");
    assert.equal(typeof pausedObjective.id, "string");
    assert.equal(typeof achievedObjective.id, "string");
    const objectiveCard = (title: string) => page.locator(".organization-objective-card").filter({ hasText: title });
    assert.match(await objectiveCard("Synthetic paused objective").innerText(), /Pausada/);
    assert.match(await objectiveCard("Synthetic achieved objective").innerText(), /Lograda/);

    stage = "link a discovered repository to its primary objective";
    const clientProjectRow = page.locator(".organization-project-row").filter({ hasText: profileClientId });
    await clientProjectRow.getByRole("checkbox", { name: "Synthetic active objective · Activa", exact: true }).check();
    await clientProjectRow.getByLabel("Objetivo principal").selectOption(String(activeObjective.id));
    const linkResponse = await observeResponse(page, `/api/organization/projects/${profileClientId}/objectives`, "PUT", () => clientProjectRow.getByRole("button", { name: "Guardar vínculos", exact: true }).click());
    assert.equal(linkResponse.status(), 200, "project objective link UI write returns 200");
    const linksBody = await linkResponse.json() as { links?: { objective_ids?: string[]; primary_objective_id?: string | null } };
    assert.deepEqual(linksBody.links?.objective_ids, [String(activeObjective.id)]);
    assert.equal(linksBody.links?.primary_objective_id, activeObjective.id);
    await objectiveCard("Synthetic active objective").getByText(`Proyectos: ${profileClientId}`, { exact: true }).waitFor();
    const personalProjectRow = page.locator(".organization-project-row").filter({ hasText: profileProjectId });
    await personalProjectRow.getByText("Personal · no requiere objetivo", { exact: true }).waitFor();

    stage = "verify cycle rejection and relationship integrity";
    const firstSessionToken = mutatingSessionHeaders.find((token) => token.length > 0);
    assert.ok(firstSessionToken, "dashboard mutations include an in-memory session token");
    const apiPost = (path: string, body: unknown, token = firstSessionToken, timeoutMs = 5_000) => observeNodeApi("POST", `${apiUrl}${path}`, timeoutMs, "response", () => fetch(`${apiUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-surtec-session": token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    }));
    const previewRequest = async (input: ContextPreviewRequest): Promise<ContextPreview> => {
      const response = await apiPost("/api/context/preview", input);
      assert.equal(response.status, 200, `synthetic ${input.kind} preview is valid: ${await response.clone().text()}`);
      const preview = await response.json() as ContextPreview;
      assert.equal(preview.allowed, true, `synthetic preview is admitted: ${preview.blocked_reasons.join("; ")}`);
      return preview;
    };
    async function hashOrAbsent(path: string) { return (await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; })) ? harnessTreeHash(path) : "absent"; }
    // The idle worker creates/removes its scheduler and root-coordination locks.
    // Keep maintenance control/participants and every other record/lock in the comparison.
    // Persistent unknown-gate refusal is tested separately; subsequent successful
    // admissions here must still prove that no retained fence blocks execution.
    let effectCaptureLabel: BrowserReadSnapshotLabel = "unlabelled";
    const effects = (readTimeoutMs = 10_000, label: BrowserReadSnapshotLabel = effectCaptureLabel) => reads!.snapshot(async () => ({ state: await harnessTreeHash(stateRoot, ["locks/orchestrator-schedule.lock", "maintenance/boundary.lock"]), worktrees: await hashOrAbsent(join(projectsRoot, "surtec-worktrees")), executor: await readFile(join(tempRoot!, "executor-effects.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return "absent"; }) }), readTimeoutMs, label);
    async function assertIssueAuthorizationRefused(path: string, body: unknown) {
      const before = await effects();
      const response = await apiPost(path, body);
      assert.equal(response.status, 409, `${path} rejects the current source state`);
      assert.deepEqual(await response.json(), { error: "issue transition rejected: transition-not-allowed" });
      assert.deepEqual(await effects(), before, `${path} preserves persisted state and execution effects`);
    }
    // Intake may append the issue aggregate, never execution authority or work.
    // This separate assertion does not weaken the full effects() comparison.
    const intakeExecutionEffects = () => reads!.snapshot(async () => ({
      stores: Object.fromEntries(await Promise.all(["tasks", "events", "workflows", "budgets"].map(async (name) => [name, await hashOrAbsent(join(stateRoot, name))]))),
      worktrees: await hashOrAbsent(join(projectsRoot, "surtec-worktrees")),
      executor: await readFile(join(tempRoot!, "executor-effects.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return "absent"; }),
    }));
    const childResponse = await fetch(`${apiUrl}/api/organization/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-surtec-session": firstSessionToken },
      body: JSON.stringify({
        title: "Synthetic child objective",
        desired_outcome: "Validate cycle protection through the real API.",
        success_criteria: ["The parent graph remains acyclic."],
        status: "draft",
        horizon: "quarter",
        priority: 3,
        target_date: null,
        parent_objective_id: activeObjective.id,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(childResponse.status, 201, "valid child objective is accepted");
    const child = (await childResponse.json() as { objective: { id: string } }).objective;
    const beforeCycle = await readApiJson<{ objectives: Array<Record<string, unknown>> }>(`${apiUrl}/api/organization`);
    const activeBeforeCycle = beforeCycle.objectives.find((objective) => objective.id === activeObjective.id);
    assert.ok(activeBeforeCycle, "parent objective remains present before cycle attempt");
    const cycleResponse = await fetch(`${apiUrl}/api/organization/objectives/${encodeURIComponent(String(activeObjective.id))}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-surtec-session": firstSessionToken },
      body: JSON.stringify({ ...activeBeforeCycle, parent_objective_id: child.id }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(cycleResponse.status, 400, "real API rejects a parent-child cycle");
    const afterCycle = await readApiJson<{ objectives: Array<Record<string, unknown>> }>(`${apiUrl}/api/organization`);
    const persistedParent = afterCycle.objectives.find((objective) => objective.id === activeObjective.id);
    const persistedChild = afterCycle.objectives.find((objective) => objective.id === child.id);
    assert.equal(persistedParent?.parent_objective_id, null, "rejected cycle leaves the original parent unchanged");
    assert.equal(persistedChild?.parent_objective_id, activeObjective.id, "rejected cycle leaves the valid child relationship intact");
    const issueObjectiveLink = await fetch(`${apiUrl}/api/organization/projects/${issueProjectId}/objectives`, {
      method: "PUT", headers: { "content-type": "application/json", "x-surtec-session": firstSessionToken },
      body: JSON.stringify({ objective_ids: [child.id], primary_objective_id: child.id }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(issueObjectiveLink.status, 200, "synthetic issue project links to its objective");

    stage = "Phase N no-effect preview, role/source guards and default privacy";
    const analysisRequest: ContextPreviewRequest = { kind: "analysis", project: issueProjectId, agent: "tech-lead", role_id: "planner", instructions: "Inspect the synthetic project without editing it.", client_context_categories: [] };
    effectCaptureLabel = "phase-n-before-preview";
    const beforePreview = await effects();
    assert.equal((await fetch(`${apiUrl}/api/context/preview`, { method: "POST", body: JSON.stringify(analysisRequest) })).status, 403, "preview requires session protection");
    const projectRoles = await readApiJson<{ roles: Array<{ id: string; agents: string[] }> }>(`${apiUrl}/api/projects/${issueProjectId}/context/roles`);
    assert.ok(projectRoles.roles.every((role) => role.agents.every((id) => ["frontend-engineer", "tech-lead"].includes(id))), "role inventory intersects the project allowlist");
    assert.equal((await apiPost("/api/context/preview", { ...analysisRequest, agent: "frontend-engineer" })).status, 403, "incompatible role/adapter is denied");
    assert.equal((await apiPost("/api/context/preview", { ...analysisRequest, agent: "product-manager", role_id: "portfolio-analyst" })).status, 403, "registered but project-disallowed adapter is denied");
    const initialPreview = await previewRequest(analysisRequest);
    assertFactoryContext(initialPreview, "explanation-status");
    assert.deepEqual(initialPreview.manifest.tools, ["inspect"], "untrusted project prose cannot add capabilities to read-only analysis");
    const publicPreview = JSON.stringify(initialPreview);
    assert.ok(!publicPreview.includes("Synthetic private project source body") && !publicPreview.includes(projectsRoot), "preview exposes attribution, not source copies or absolute paths");
    assert.deepEqual(initialPreview.manifest.selected_categories, []);
    assert.ok(initialPreview.manifest.sources.some((source) => source.id === "project/docs/smoke-context.md"));
    const analysisDispatch = { project: analysisRequest.project, agent: analysisRequest.agent, role_id: analysisRequest.role_id, instructions: analysisRequest.instructions, sandbox: "read-only", preview_fingerprint: initialPreview.fingerprint, client_context_categories: [] };
    assert.equal((await apiPost("/api/tasks", { ...analysisDispatch, instructions: "Changed analysis request" })).status, 409, "changed request cannot reuse preview");
    const selectedSource = join(syntheticRepo, "docs/smoke-context.md"), selectedBytes = await readFile(selectedSource);
    try {
      await writeFile(selectedSource, "Changed private project source.\n");
      assert.equal((await apiPost("/api/tasks", analysisDispatch)).status, 409, "changed required source cannot reuse preview");
      await writeFile(selectedSource, "x".repeat(60_001));
      assert.equal((await apiPost("/api/context/preview", analysisRequest)).status, 409, "oversized required source is rejected, not silently truncated");
      await unlink(selectedSource);
      assert.equal((await apiPost("/api/context/preview", analysisRequest)).status, 409, "missing required source blocks preview");
    } finally { await writeFile(selectedSource, selectedBytes); }
    effectCaptureLabel = "phase-n-after-api-refusals";
    assert.deepEqual(await effects(), beforePreview, "all previews and refusals leave state, worktrees and executor effects unchanged");

    await page.getByRole("button", { name: "Overview", exact: true }).click();
    const taskForm = page.locator(".task-panel");
    await taskForm.getByLabel("Proyecto", { exact: true }).selectOption(profileClientId);
    await taskForm.getByLabel("Perfil Codex", { exact: true }).selectOption("planner");
    assert.deepEqual(await taskForm.getByLabel("Agente", { exact: true }).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)), ["tech-lead"], "analysis adapter choices intersect role and project policy");
    assert.ok(await taskForm.getByLabel("Modo", { exact: true }).locator("option").evaluateAll((options) => options.every((option) => (option as HTMLOptionElement).value === "read-only" || (option as HTMLOptionElement).disabled)), "analysis form never enables writes");
    await taskForm.getByLabel("Instrucciones", { exact: true }).fill("Inspect the synthetic client project without editing or sharing client data.");
    const consent = taskForm.locator(".task-client-context input[type=checkbox]");
    await consent.first().waitFor();
    assert.ok((await consent.evaluateAll((inputs) => inputs.every((input) => !(input as HTMLInputElement).checked))), "client categories start unchecked");
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "analysis requires explicit preview");
    const previewButton = taskForm.getByRole("button", { name: "Previsualizar contexto", exact: true });
    const browserPreviewResponse = await observeResponse(page, "/api/context/preview", "POST", () => previewButton.click());
    assert.equal(browserPreviewResponse.status(), 200);
    const browserPreview = await browserPreviewResponse.json() as ContextPreview;
    assert.equal(browserPreview.allowed, true);
    assert.deepEqual(browserPreview.manifest.selected_categories, []);
    const previewPanel = taskForm.getByRole("region", { name: "Preview de contexto" });
    await previewPanel.getByText("Contexto habilitado para este pedido.", { exact: true }).waitFor();
    assert.ok(!(await previewPanel.innerText()).includes("Synthetic confidential client body"));
    await taskForm.getByLabel("Perfil Codex", { exact: true }).selectOption("software-engineer");
    assert.equal(await taskForm.getByLabel("Modo", { exact: true }).inputValue(), "read-only", "a write ceiling never changes the requested analysis mode");
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "profile change discards preview");
    await taskForm.getByLabel("Perfil Codex", { exact: true }).selectOption("planner");
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "switching back cannot restore the old preview");
    await taskForm.getByRole("checkbox", { name: "Notas confidenciales del cliente · confidencial", exact: true }).check();
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "consent change invalidates preview");
    const selectedPreviewResponse = await observeResponse(page, "/api/context/preview", "POST", () => previewButton.click());
    const selectedPreview = await selectedPreviewResponse.json() as ContextPreview;
    assert.equal(selectedPreview.allowed, true); assert.deepEqual(selectedPreview.manifest.selected_categories, ["confidential-notes"]);
    assert.ok(selectedPreview.manifest.sources.some((source) => source.id === "client/explicit-consent"));
    assert.ok(!JSON.stringify(selectedPreview).includes(syntheticClient.confidential_notes) && !(await previewPanel.innerText()).includes(syntheticClient.confidential_notes), "selected confidential body stays out of preview and DOM");
    const browserRequest = browserPreviewResponse.request().postDataJSON() as ContextPreviewRequest;
    assert.equal((await apiPost("/api/tasks", { ...browserRequest, kind: undefined, sandbox: "read-only", preview_fingerprint: selectedPreview.fingerprint })).status, 409, "consent-mismatched dispatch has no effects");
    await taskForm.getByRole("checkbox", { name: "Notas confidenciales del cliente · confidencial", exact: true }).uncheck();
    await taskForm.getByLabel("Instrucciones", { exact: true }).fill("Edited synthetic analysis request");
    await taskForm.getByLabel("Instrucciones", { exact: true }).fill(browserRequest.instructions!);
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "editing back to the original request cannot resurrect preview");
    const defaultPreviewResponse = await observeResponse(page, "/api/context/preview", "POST", () => previewButton.click());
    const defaultPreview = await defaultPreviewResponse.json() as ContextPreview;
    assert.equal(defaultPreview.allowed, true); assert.deepEqual(defaultPreview.manifest.selected_categories, []);
    effectCaptureLabel = "phase-n-after-browser-previews";
    assert.deepEqual(await effects(), beforePreview, "browser previews/consent mismatch do not persist state or invoke the executor");
    effectCaptureLabel = "unlabelled";
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "analysis preview has no mobile overflow");
    assert.ok(await previewButton.evaluate((element) => element.getBoundingClientRect().width < 280), "preview control stays compact");
    const profileTheme = await taskForm.getByLabel("Perfil Codex", { exact: true }).evaluate((element) => ({ scheme: getComputedStyle(element).colorScheme, options: [...element.querySelectorAll("option")].map((option) => ({ color: getComputedStyle(option).color, background: getComputedStyle(option).backgroundColor })) }));
    assert.equal(profileTheme.scheme, "dark"); assert.ok(profileTheme.options.every((option) => option.color !== option.background), "profile choices remain contrasting without hover");
    await page.setViewportSize({ width: 1440, height: 1000 });
    stage = "Phase N real read-only analysis and recorded manifest inspection";
    const beforeAnalysis = await harnessTreeHash(join(projectsRoot, profileClientId));
    const analysisResponse = await observeResponse(page, "/api/tasks", "POST", () => taskForm.getByRole("button", { name: "Despachar", exact: true }).click());
    assert.equal(analysisResponse.status(), 201);
    const analysisId = (await analysisResponse.json() as { id: string }).id;
    const analysisTask = await waitForTask(apiUrl, analysisId);
    assert.equal(analysisTask.outcome, "completed");
    assert.deepEqual(analysisTask.envelope.context_manifest, defaultPreview.manifest);
    assert.deepEqual(analysisTask.envelope.context_manifest!.selected_categories, []);
    assert.ok(!analysisTask.envelope.instructions.includes(syntheticClient.confidential_notes) && analysisTask.envelope.metadata.client_context_share === undefined, "default dispatch stores no client body or consent audit");
    assert.equal(await harnessTreeHash(join(projectsRoot, profileClientId)), beforeAnalysis, "read-only executor leaves synthetic project bytes unchanged");
    await page.locator(".hist-row").getByRole("button", { name: analysisId, exact: true }).click();
    const recordedManifest = page.getByRole("region", { name: "Manifiesto de contexto" });
    await recordedManifest.getByText(defaultPreview.fingerprint, { exact: true }).waitFor();
    await recordedManifest.getByText("planner", { exact: true }).waitFor();
    await reads.navigate(() => page.reload({ waitUntil: "domcontentloaded" }));
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator(".hist-row").getByRole("button", { name: analysisId, exact: true }).click();
    await recordedManifest.getByText(defaultPreview.fingerprint, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Volver", exact: true }).click();

    const pendingIntakeKey = "surtec.work-issue.pending-request.v1";
    const intakePosts: ManualIssueCreateInput[] = [];
    const recordIntake = (request: Request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/work-issues") intakePosts.push(request.postDataJSON() as ManualIssueCreateInput);
    };
    page.on("request", recordIntake);
    const fillManualIssue = async (title: string) => {
      await page.getByRole("button", { name: "Issues", exact: true }).click();
      await page.getByText("Trabajo aprobado", { exact: true }).waitFor();
      const disclosure = page.locator(".work-issue-create");
      if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) await disclosure.locator("summary").click();
      await page.getByLabel("Repositorio local").selectOption(issueProjectId);
      await page.getByLabel("Agente habilitado", { exact: true }).selectOption("frontend-engineer");
      await page.getByLabel("Objetivo SURTEC", { exact: true }).selectOption(child.id);
      await disclosure.locator("label").filter({ hasText: "Título" }).locator("input").fill(title);
      await disclosure.locator("label").filter({ hasText: "Resultado esperado" }).locator("textarea").fill("A synthetic issue stays local and has a visible authorized scope.");
      await disclosure.locator("label").filter({ hasText: "Criterios de aceptación" }).locator("textarea").fill("The proposed path is displayed with its scope revision.");
      await disclosure.locator("label").filter({ hasText: "Paths permitidos" }).locator("textarea").fill("dashboard/src/**");
      await disclosure.locator("label").filter({ hasText: "Categorías de cambio" }).locator("input").fill("dashboard UI");
      assert.equal(await disclosure.locator("form").evaluate((element) => (element as HTMLFormElement).checkValidity()), true, "synthetic manual issue form is valid");
    };
    const discardIntakeAcknowledgement = async (action: () => Promise<unknown>) => {
      let persisted: { payload: ManualIssueCreateInput; issue: WorkIssue } | null = null;
      let injectionFailure: unknown;
      let injected = 0;
      const handler = async (route: Route) => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        try {
          assert.equal(++injected, 1, "one browser submission reaches the acknowledgement fault");
          const payload = route.request().postDataJSON() as ManualIssueCreateInput;
          assert.match(payload.request_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
          const saved = await page.evaluate((key) => ({ id: sessionStorage.getItem(key), values: Object.values(sessionStorage) }), pendingIntakeKey);
          assert.equal(saved.id, payload.request_id, "the UUID is retained before POST reaches the API");
          assert.ok(saved.values.every((value) => !value.includes(payload.title) && !value.includes(payload.expected_outcome)), "private form bodies are absent from sessionStorage");
          const response = await route.fetch({ timeout: 10_000, maxRetries: 0 });
          assert.equal(response.status(), 201, "the real API persists before its acknowledgement is discarded");
          const body = await response.json() as { issue: WorkIssue };
          assert.equal(body.issue.intake_receipt?.request_id, payload.request_id);
          persisted = { payload, issue: body.issue };
          // Preserve a successful transport while withholding confirmation of
          // the real write. A transport abort would add an unrelated console error.
          await route.fulfill({ response, json: {} });
        } catch (error) {
          injectionFailure = error;
          await route.fulfill({ status: 200, json: {} }).catch(() => undefined);
        }
      };
      await page.route("**/api/work-issues", handler);
      try {
        const response = await observeResponse(page, "/api/work-issues", "POST", action);
        if (injectionFailure) throw injectionFailure;
        assert.equal(response.status(), 201);
        await page.getByRole("region", { name: "Pedido local pendiente", exact: true }).getByText("No se pudo confirmar la creación. Conservamos el mismo pedido para comprobarlo o reintentarlo sin duplicarlo.", { exact: true }).waitFor();
        assert.ok(persisted, "a real persisted issue was observed before losing its acknowledgement");
        return persisted as { payload: ManualIssueCreateInput; issue: WorkIssue };
      } finally { await page.unroute("**/api/work-issues", handler); }
    };

    stage = "create and explicitly authorize a local issue through the real dashboard";
    await fillManualIssue("Synthetic local issue proposal");
    const beforeIntakeExecution = await intakeExecutionEffects();
    const lostCreation = await discardIntakeAcknowledgement(() => page.locator(".work-issue-create form").evaluate((element) => {
      (element as HTMLFormElement).requestSubmit(); (element as HTMLFormElement).requestSubmit();
    }));
    assert.equal(intakePosts.length, 1, "double submit produces only one logical POST");
    assert.equal(await page.getByRole("button", { name: "Crear propuesta local", exact: true }).isDisabled(), true, "unconfirmed creation blocks a new intent");
    assert.equal(await page.locator('fieldset[aria-label="Datos del pedido local"]').evaluate((element) => (element as HTMLFieldSetElement).disabled), true, "pending form data cannot change the retry payload");
    const intakePath = join(stateRoot, "issues/issues.json");
    const persistedIntakeBytes = await reads.snapshot(() => readFile(intakePath));
    const issueCreateResponse = await observeResponse(page, "/api/work-issues", "POST", () => page.getByRole("button", { name: "Reintentar mismo pedido", exact: true }).click());
    assert.equal(issueCreateResponse.status(), 201, "local issue creation returns 201 through the real API");
    const issueCreateBody = await issueCreateResponse.json() as { issue?: WorkIssue };
    assert.ok(issueCreateBody.issue && issueCreateBody.issue.status === "proposed", "new local issue starts proposed, not authorized");
    assert.equal(issueCreateBody.issue.work_scale, "trivial", "narrow synthetic issue is classified deterministically");
    assert.deepEqual(issueCreateBody.issue, lostCreation.issue, "explicit retry recovers the same issue after its acknowledgement was lost");
    await page.getByText(`Pedido confirmado: ${issueCreateBody.issue.id}.`, { exact: true }).waitFor();
    await page.getByRole("region", { name: "Pedido local pendiente", exact: true }).waitFor({ state: "hidden" });
    assert.equal(intakePosts.length, 2, "only explicit retry adds a second browser POST");
    assert.deepEqual(intakePosts[1], lostCreation.payload, "explicit retry preserves the exact frozen payload and UUID");
    assert.deepEqual(await reads.snapshot(() => readFile(intakePath)), persistedIntakeBytes, "replay adds no issue, event, revision or state write");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), pendingIntakeKey), null, "confirmed retry closes its stored identity");
    assert.deepEqual(await intakeExecutionEffects(), beforeIntakeExecution, "intake and replay create no task, grant, worktree or executor effect");
    const issueCard = page.locator(".work-issue-card").filter({ hasText: "Synthetic local issue proposal" });
    await issueCard.getByText("proposed", { exact: true }).waitFor();
    const issueInput = issueCreateResponse.request().postDataJSON() as ManualIssueCreateInput;
    const originalReceipt = issueCreateBody.issue.intake_receipt;
    assert.equal(originalReceipt?.request_id, issueInput.request_id);
    assert.match(originalReceipt?.request_fingerprint ?? "", /^[a-f0-9]{64}$/);
    const assertOriginalReplay = async (expected: WorkIssue, token = firstSessionToken) => {
      const beforeBytes = await reads!.snapshot(() => readFile(intakePath));
      const beforeFullEffects = await effects();
      const beforeExecution = await intakeExecutionEffects();
      const response = await apiPost("/api/work-issues", issueInput, token);
      assert.equal(response.status, 201, "the original key replays after issue progress or API restart");
      const current = (await response.json() as { issue: WorkIssue }).issue;
      assert.deepEqual(current, expected, "replay returns current progress instead of restoring the proposal");
      assert.deepEqual(current.intake_receipt, originalReceipt, "original intake identity stays immutable");
      assert.deepEqual(await reads!.snapshot(() => readFile(intakePath)), beforeBytes, "progress/restart replay preserves exact issue aggregate bytes");
      assert.deepEqual(await effects(), beforeFullEffects, "progress/restart replay preserves all state without changing existing effect exclusions");
      assert.deepEqual(await intakeExecutionEffects(), beforeExecution, "progress/restart replay never admits execution");
    };
    assert.equal((await apiPost(`/api/work-issues/${issueCreateBody.issue.id}/dispatch`, { expected_revision: issueCreateBody.issue.revision, agent: "frontend-engineer" })).status, 409, "proposal cannot dispatch before authorization");
    assert.equal((await apiPost("/api/tasks", { project: issueProjectId, agent: "frontend-engineer", sandbox: "workspace-write", instructions: "Synthetic direct write bypass", metadata: { issue_id: issueCreateBody.issue.id } })).status, 409, "generic task route cannot forge trusted issue write lineage");
    assert.equal((await apiPost("/api/work-issues", { ...issueInput, request_id: randomUUID(), criticality: "high" })).status, 400, "substantial work cannot bypass its durable plan");
    const proposedPreviewResponse = await apiPost("/api/context/preview", { kind: "issue", project: issueProjectId, agent: "frontend-engineer", role_id: "software-engineer", issue_id: issueCreateBody.issue.id, expected_revision: issueCreateBody.issue.revision });
    assert.equal(proposedPreviewResponse.status, 200); assert.equal((await proposedPreviewResponse.json() as ContextPreview).allowed, false, "preview does not authorize proposed work");
    stage = "recover lost intake acknowledgement through reload without recreating work";
    await fillManualIssue("Synthetic reload recovery proposal");
    const lostReload = await discardIntakeAcknowledgement(() => page.getByRole("button", { name: "Crear propuesta local", exact: true }).click());
    assert.notEqual(lostReload.payload.request_id, issueInput.request_id, "a later deliberate intent owns a new UUID");
    const reloadPostCount = intakePosts.length;
    const reloadBytes = await reads.snapshot(() => readFile(intakePath));
    await reads.navigate(() => page.reload({ waitUntil: "domcontentloaded" }));
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await page.getByText(`Pedido confirmado: ${lostReload.issue.id}.`, { exact: true }).waitFor();
    assert.equal(intakePosts.length, reloadPostCount, "reload resolves the stored identity using GET with no automatic POST");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), pendingIntakeKey), null);
    assert.deepEqual(await reads.snapshot(() => readFile(intakePath)), reloadBytes, "reload recovery preserves the persisted issue aggregate");
    assert.deepEqual(await intakeExecutionEffects(), beforeIntakeExecution, "reload recovery grants no execution authority");

    const beforeConflict = await reads.snapshot(() => readFile(intakePath)), beforeConflictEffects = await effects();
    for (const refusal of [
      { payload: { ...issueInput, title: "Synthetic conflicting request payload" }, status: 409 },
      { payload: { ...issueInput, project_id: workflowProjectId }, status: 409 },
      { payload: { ...issueInput, request_id: undefined }, status: 400 },
    ]) {
      const response = await apiPost("/api/work-issues", refusal.payload);
      assert.equal(response.status, refusal.status, "manual HTTP creation requires an unchanged explicit request identity");
      assert.deepEqual(await reads.snapshot(() => readFile(intakePath)), beforeConflict, "conflicting identity preserves exact aggregate bytes");
      assert.deepEqual(await effects(), beforeConflictEffects, "missing or conflicting identity changes no server state or execution effects");
    }
    const distinctResponse = await apiPost("/api/work-issues", { ...lostReload.payload, request_id: randomUUID() });
    assert.equal(distinctResponse.status, 201, "distinct UUIDs may represent identical deliberate request content");
    const distinctIssue = (await distinctResponse.json() as { issue: WorkIssue }).issue;
    assert.notEqual(distinctIssue.id, lostReload.issue.id);
    assert.equal(distinctIssue.intake_receipt?.request_fingerprint, lostReload.issue.intake_receipt?.request_fingerprint);
    assert.notEqual(distinctIssue.intake_receipt?.request_id, lostReload.payload.request_id);
    assert.equal(distinctIssue.status, "proposed");
    assert.deepEqual(distinctIssue.task_ids, []);
    assert.deepEqual(await intakeExecutionEffects(), beforeIntakeExecution, "distinct proposals and conflicts admit no tasks or grants");

    stage = "retain unresolved intake until an explicit acknowledged cancellation";
    const unknownRequestId = randomUUID(), beforeUnknown = await effects(), unknownPostCount = intakePosts.length;
    await page.evaluate(({ key, id }) => sessionStorage.setItem(key, id), { key: pendingIntakeKey, id: unknownRequestId });
    await reads.navigate(() => page.reload({ waitUntil: "domcontentloaded" }));
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    const pendingIntake = page.getByRole("region", { name: "Pedido local pendiente", exact: true });
    await pendingIntake.getByText("No se pudo confirmar el pedido en esta lectura. Su ausencia no demuestra que no se haya creado.", { exact: true }).waitFor();
    assert.equal(intakePosts.length, unknownPostCount, "missing GET evidence never recreates an unresolved request");
    assert.equal(await pendingIntake.getByRole("button", { name: "Reintentar mismo pedido", exact: true }).count(), 0, "reload retains no private payload to resend");
    assert.equal(await page.locator('.work-issue-create button[type="submit"]').isDisabled(), true);
    assert.equal(await pendingIntake.getByRole("button", { name: "Cancelar intento pendiente", exact: true }).isDisabled(), true, "cancellation requires a separate acknowledgement");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), pendingIntakeKey), unknownRequestId);
    await pendingIntake.getByRole("checkbox", { name: "Entiendo que el pedido podría existir; cancelar este intento no lo elimina.", exact: true }).check();
    await pendingIntake.getByRole("button", { name: "Cancelar intento pendiente", exact: true }).click();
    await pendingIntake.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), pendingIntakeKey), null);
    assert.equal(intakePosts.length, unknownPostCount, "acknowledged cancellation does not create a replacement issue");
    assert.deepEqual(await effects(), beforeUnknown, "uncertainty and cancellation leave all server state and execution effects unchanged");
    assert.deepEqual(await intakeExecutionEffects(), beforeIntakeExecution);
    page.off("request", recordIntake);

    stage = "reject resume and decision resolution from a proposed issue";
    const proposedIssuePath = `/api/work-issues/${issueCreateBody.issue.id}`;
    const proposedRevision = issueCreateBody.issue.revision;
    await assertIssueAuthorizationRefused(`${proposedIssuePath}/resume`, {
      expected_revision: proposedRevision, rationale: "Synthetic blocker resolution.",
    });
    await assertIssueAuthorizationRefused(`${proposedIssuePath}/resolve-decision`, {
      expected_revision: proposedRevision, approval_id: "synthetic-decision-approval", rationale: "Synthetic same-scope decision.",
    });
    assert.ok(await issueCard.getByText("proposed", { exact: true }).isVisible());

    stage = "authorize the proposed issue through the dashboard";
    const authorizeIssueResponse = await observeResponse(page, `${proposedIssuePath}/authorize`, "POST", () => issueCard.getByRole("button", { name: "Autorizar scope exacto", exact: true }).click());
    assert.equal(authorizeIssueResponse.status(), 200, "exact-scope authorization is an authenticated human action");
    const authorizedIssue = (await authorizeIssueResponse.json() as { issue: { revision: number } }).issue;
    await issueCard.getByText("authorized", { exact: true }).waitFor();
    await issueCard.getByLabel("Agente autorizado de Synthetic local issue proposal", { exact: true }).locator('option[value="frontend-engineer"]').waitFor({ state: "attached" });
    assert.equal(await issueCard.getByLabel("Agente autorizado de Synthetic local issue proposal", { exact: true }).inputValue(), "frontend-engineer");
    assert.equal(await issueCard.getByLabel("Agente autorizado de Synthetic local issue proposal", { exact: true }).isDisabled(), true, "existing assignment cannot be silently replaced in the browser");
    stage = "dispatch a synthetic executor through the real API, runner and managed Git worktree";
    const beforeIssuePreview = await effects();
    assert.equal((await apiPost("/api/context/preview", { kind: "issue", project: issueProjectId, agent: "frontend-engineer", role_id: "software-engineer", issue_id: issueCreateBody.issue.id, expected_revision: issueCreateBody.issue.revision })).status, 409, "old issue revision needs a new preview");
    assert.equal(await issueCard.getByRole("button", { name: "Despachar tarea aprobada", exact: true }).isDisabled(), true);
    const issuePreviewResponse = await observeResponse(page, "/api/context/preview", "POST", () => issueCard.getByRole("button", { name: "Previsualizar contexto del issue", exact: true }).click());
    assert.equal(issuePreviewResponse.status(), 200);
    const issuePreview = await issuePreviewResponse.json() as ContextPreview;
    assertFactoryContext(issuePreview, "architecture-implementation");
    assert.equal(issuePreview.allowed, true); assert.equal(issuePreview.manifest.role_id, "software-engineer");
    assert.equal(issuePreview.manifest.sandbox, "workspace-write"); assert.deepEqual(issuePreview.manifest.selected_categories, []);
    assert.equal(issuePreviewResponse.request().postDataJSON().expected_revision, authorizedIssue.revision);
    assert.deepEqual(await effects(), beforeIssuePreview, "issue preview and stale revision refusal have no execution effects");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "issue profile/preview has no mobile overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const dispatchResponse = await observeResponse(page, `/api/work-issues/${issueCreateBody.issue.id}/dispatch`, "POST", () => issueCard.getByRole("button", { name: "Despachar tarea aprobada", exact: true }).click());
    assert.equal(dispatchResponse.status(), 201, "approved issue admits a linked task");
    let readyLineage: import("../lib/issues/types").IssueLineage | null = null;
    const executionDeadline = Date.now() + 30_000;
    while (Date.now() < executionDeadline) {
      readyLineage = await readApiJson(`${apiUrl}/api/work-issues/${issueCreateBody.issue!.id}`);
      if (["ready-for-review", "blocked", "needs-decision"].includes(readyLineage!.issue.status)) break;
      await delay(200);
    }
    assert.equal(readyLineage?.issue.status, "ready-for-review", `real runner produces a verified candidate with the injected fake executor (${readyLineage?.issue.next_action ?? "no blocker recorded"})`);
    assert.equal(readyLineage.tasks.length, 1);
    assert.equal(readyLineage.issue.objective_id, child.id, "objective -> project -> issue lineage remains queryable");
    assert.equal(readyLineage.tasks[0]!.executions.length, 1, "execution attempts are queryable");
    assert.deepEqual(readyLineage.tasks[0]!.task.envelope.context_manifest, issuePreview.manifest, "write task stores the admitted manifest");
    assert.equal(readyLineage.tasks[0]!.task.testing_evidence?.schema_version, 1, "real configured verification creates an infrastructure receipt");
    const candidate = readyLineage.candidates.find((entry) => entry.invalidated_at === null)!;
    assert.deepEqual(candidate.changed_paths, ["dashboard/src/fixture.txt"]);
    assert.match(candidate.diff_fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(readyLineage.evidence.some((entry) => entry.kind === "verification" && entry.status === "passed" && entry.candidate_id === candidate.id), "verification evidence binds the exact candidate");
    const acceptanceInput = { expected_revision: readyLineage.issue.revision, candidate_id: candidate.id, fingerprint: candidate.diff_fingerprint, approval_id: "synthetic-negative-review", rationale: "Synthetic review guard test", confirmed_criteria: readyLineage.issue.acceptance_criteria };
    assert.equal((await apiPost(`/api/work-issues/${issueCreateBody.issue.id}/accept`, { ...acceptanceInput, fingerprint: "0".repeat(64) })).status, 409, "stale fingerprint cannot complete an issue");
    assert.equal((await apiPost(`/api/work-issues/${issueCreateBody.issue.id}/accept`, { ...acceptanceInput, confirmed_criteria: [] })).status, 400, "empty acceptance criteria cannot complete an issue");
    assert.equal((await apiPost(`/api/work-issues/${issueCreateBody.issue.id}/dispatch`, { expected_revision: readyLineage.issue.revision, agent: "frontend-engineer" })).status, 409, "duplicate dispatch does not create a second task");
    assert.equal(execFileSync("git", ["-C", syntheticRepo, "log", "--format=%s", "-1"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), "Synthetic fixture baseline", "source checkout remains unchanged");
    await page.getByRole("button", { name: "Actualizar", exact: true }).click();
    await issueCard.getByRole("button", { name: "Revisar candidato", exact: true }).click();
    const acceptButton = issueCard.getByRole("button", { name: "Aceptar este candidato local", exact: true });
    assert.equal(await acceptButton.isDisabled(), true, "acceptance needs explicit criteria confirmation");
    await issueCard.getByRole("checkbox", { name: "The proposed path is displayed with its scope revision.", exact: true }).check();
    const acceptResponse = await observeResponse(page, `/api/work-issues/${issueCreateBody.issue.id}/accept`, "POST", () => acceptButton.click());
    assert.equal(acceptResponse.status(), 200, "local acceptance runs through the authenticated API");
    await issueCard.getByText("done", { exact: true }).waitFor();
    const doneLineage = await readApiJson<import("../lib/issues/types").IssueLineage>(`${apiUrl}/api/work-issues/${issueCreateBody.issue!.id}`);
    await assertOriginalReplay(doneLineage.issue);
    assert.deepEqual(doneLineage.evidence_gaps, [], "completion has verification and human-review evidence");
    assert.ok(doneLineage.evidence.some((entry) => entry.kind === "review" && entry.candidate_revision === candidate.candidate_revision && entry.diff_fingerprint === candidate.diff_fingerprint));
    const reviewLineageStale = (await issueCard.locator(".work-issue-lineage").innerText()).includes("Human acceptance evidence is missing");
    const sessionResponse = await apiPost("/api/sessions", { project_id: issueProjectId, objective: "Synthetic issue verification session", related_task_ids: [doneLineage.tasks[0]!.task.envelope.id] });
    assert.equal(sessionResponse.status, 201);
    const session = (await sessionResponse.json() as { session: { id: string } }).session;
    assert.equal((await apiPost(`/api/sessions/${session.id}/action`, { action: "complete", result_summary: "Synthetic candidate reviewed", next_action: "No further fixture work" })).status, 200);
    const sessionLineage = await readApiJson<import("../lib/issues/types").IssueLineage>(`${apiUrl}/api/work-issues/${issueCreateBody.issue.id}`);
    assert.equal(sessionLineage.sessions[0]?.id, session.id, "work session is queryable through issue task lineage");
    stage = "verify out-of-scope work stops before commit and requires a browser decision";
    const scopeOutcomes: Array<{ id: string; status: string; scope_revision: number }> = [];
    for (const decision of ["approve", "reject"] as const) {
      const title = `Synthetic scope discovery ${decision}`;
      stage = `scope ${decision}: create synthetic issue`;
      const createdResponse = await apiPost("/api/work-issues", { ...issueInput, request_id: randomUUID(), title });
      assert.equal(createdResponse.status, 201);
      const proposed = (await createdResponse.json() as { issue: { id: string; revision: number } }).issue;
      stage = `scope ${decision}: authorize exact issue revision`;
      const authorizedResponse = await apiPost(`/api/work-issues/${proposed.id}/authorize`, { expected_revision: proposed.revision, approval_id: "synthetic-scope-approval" });
      assert.equal(authorizedResponse.status, 200);
      const authorized = (await authorizedResponse.json() as { issue: { revision: number } }).issue;
      stage = `scope ${decision}: preview authorized issue context`;
      const scopePreview = await previewRequest({ kind: "issue", project: issueProjectId, agent: "frontend-engineer", role_id: "software-engineer", issue_id: proposed.id, expected_revision: authorized.revision, client_context_categories: [] });
      stage = `scope ${decision}: dispatch authorized task`;
      assert.equal((await apiPost(`/api/work-issues/${proposed.id}/dispatch`, { expected_revision: authorized.revision, agent: "frontend-engineer", role_id: "software-engineer", preview_fingerprint: scopePreview.fingerprint, client_context_categories: [] })).status, 201);
      let detail: import("../lib/issues/types").IssueLineage | null = null;
      const deadline = Date.now() + 30_000;
      stage = `scope ${decision}: GET issue lineage while awaiting finished needs-decision`;
      while (Date.now() < deadline) {
        detail = await readApiJson(`${apiUrl}/api/work-issues/${proposed.id}`);
        if (detail!.issue.status === "needs-decision" && detail!.tasks[0]?.task.lifecycle === "finished") break;
        await delay(200);
      }
      assert.equal(detail?.issue.status, "needs-decision");
      assert.equal(detail.issue.scope_revision, 1, "discovery alone grants no new scope");
      assert.deepEqual(detail.issue.authorized_scope.allowed_path_patterns, ["dashboard/src/**"]);
      assert.equal(detail.candidates.length, 0, "out-of-scope attempt creates no review candidate");
      const run = detail.tasks[0]!.task.envelope.metadata.run as { worktree_path: string };
      assert.ok(isInside(tempRoot, run.worktree_path), "scope fixture worktree stays temporary");
      assert.equal(execFileSync("git", ["-C", run.worktree_path, "log", "--format=%s", "-1"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), "Synthetic fixture baseline", "scope violation stops before Git commit");
      stage = `scope ${decision}: browser refresh and exact scope decision`;
      await page.getByRole("button", { name: "Actualizar", exact: true }).click();
      const card = page.locator(".work-issue-card").filter({ hasText: title });
      await card.getByText("needs-decision", { exact: true }).waitFor();
      if (decision === "approve") {
        stage = "reject initial authorization while a scope decision is pending";
        await assertIssueAuthorizationRefused(`/api/work-issues/${proposed.id}/authorize`, {
          expected_revision: detail.issue.revision, approval_id: "synthetic-initial-approval",
        });
        assert.ok(await card.getByText("needs-decision", { exact: true }).isVisible());
        stage = "approve the new scope revision through the dashboard";
      }
      const decisionResponse = await observeResponse(page, `/api/work-issues/${proposed.id}/scope-decision`, "POST", () => card.getByRole("button", { name: decision === "approve" ? "Autorizar nueva revisión de scope" : "Rechazar y cancelar issue", exact: true }).click());
      assert.equal(decisionResponse.status(), 200);
      stage = `scope ${decision}: GET issue lineage after browser decision`;
      const changed = (await readApiJson<import("../lib/issues/types").IssueLineage>(`${apiUrl}/api/work-issues/${proposed.id}`)).issue;
      assert.equal(changed.status, decision === "approve" ? "authorized" : "cancelled");
      assert.equal(changed.scope_revision, decision === "approve" ? 2 : 1);
      scopeOutcomes.push({ id: changed.id, status: changed.status, scope_revision: changed.scope_revision });
    }
    const issueLayout = await issueCard.evaluate((element) => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth }));
    assert.ok(issueLayout.scroll <= issueLayout.width + 1, `local issue card stays within its desktop width (${JSON.stringify(issueLayout)})`);
    await page.setViewportSize({ width: 390, height: 844 });
    const issueMobileLayout = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(issueMobileLayout.document <= issueMobileLayout.viewport + 1, `local issue view has no mobile horizontal overflow (${JSON.stringify(issueMobileLayout)})`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "SURTEC", exact: true }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();

    stage = "verify browser layout and reload persistence";
    const profileControls = await page.locator(".organization-company-form input").evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      buttonWidth: document.querySelector(".organization-company-form > .ibtn")?.getBoundingClientRect().width ?? 0,
    }));
    assert.equal(profileControls.background, "rgb(10, 20, 32)", "profile input uses the dark theme");
    assert.ok(profileControls.buttonWidth < 220, "profile save control stays compact");
    const projectControls = await clientProjectRow.evaluate((element) => ({
      buttonWidth: element.querySelector(".organization-project-links > .ibtn")?.getBoundingClientRect().width ?? 0,
      selectMaxWidth: element.querySelector(".organization-project-links select") ? getComputedStyle(element.querySelector(".organization-project-links select")!).maxWidth : "",
    }));
    assert.ok(projectControls.buttonWidth < 220, "project link save control stays compact");
    assert.equal(projectControls.selectMaxWidth, "460px", "project objective dropdown has a bounded width");
    const objectiveSelect = page.locator(".organization-objective-form select").first();
    const optionTheme = await objectiveSelect.evaluate((element) => ({
      scheme: getComputedStyle(element).colorScheme,
      options: Array.from(element.querySelectorAll("option"), (option) => ({ color: getComputedStyle(option).color, background: getComputedStyle(option).backgroundColor })),
    }));
    assert.equal(optionTheme.scheme, "dark", "native objective dropdown uses the dark color scheme");
    assert.ok(optionTheme.options.every((option) => ["rgb(243, 249, 252)", "rgb(255, 255, 255)"].includes(option.color)), "dropdown choices use readable text");
    assert.ok(optionTheme.options.every((option) => ["rgb(14, 27, 42)", "rgb(31, 78, 112)"].includes(option.background)), "dropdown choices use a contrasting background");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      companyButton: document.querySelector(".organization-company-form > .ibtn")?.getBoundingClientRect().width ?? 0,
      linksButton: document.querySelector(".organization-project-links > .ibtn")?.getBoundingClientRect().width ?? 0,
    }));
    assert.ok(mobileLayout.document <= mobileLayout.viewport + 1, `mobile organization view has no horizontal overflow (${JSON.stringify(mobileLayout)})`);
    assert.ok(mobileLayout.companyButton < 220 && mobileLayout.linksButton < 220, "mobile save controls stay compact");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await reads.navigate(() => page.reload({ waitUntil: "domcontentloaded" }));
    await page.getByText("Cockpit diario").waitFor();
    await page.getByRole("button", { name: "SURTEC", exact: true }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Misión").inputValue(), "Synthetic local acceptance mission.", "company profile survives a browser reload");
    await objectiveCard("Synthetic active objective").waitFor();
    await objectiveCard("Synthetic paused objective").waitFor();
    await objectiveCard("Synthetic achieved objective").waitFor();
    await objectiveCard("Synthetic active objective").getByText(`Proyectos: ${profileClientId}`, { exact: true }).waitFor();
    assert.ok(browserErrors.length === 0 && browserHttpErrors.length === 0, `browser has no console, page, or HTTP errors (${[...browserErrors, ...browserHttpErrors].join(" | ")})`);

    stage = "Phase M real API/browser read-only inventory, Doctor and explicit observation refresh";
    const harnessProjectRoot = join(projectsRoot, profileProjectId);
    const beforeHarness = await harnessTreeHash(harnessProjectRoot);
    const healthyHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness/doctor`);
    assert.equal(healthyHarness.observation.status, "healthy");
    assert.equal(healthyHarness.observation.comparison, "compatible");
    assert.equal(healthyHarness.saved, null, "GET Doctor does not persist observations");
    assert.equal(healthyHarness.observation.validation.status, "unknown", "script presence is not execution evidence");
    assert.equal(healthyHarness.observation.entries.find((entry) => entry.path === "AGENTS.md")?.ownership, "user-owned");
    assert.equal(healthyHarness.observation.testing_policy.mode, "functional");
    const partialHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileClientId}/harness`);
    assert.equal(partialHarness.observation.status, "partial");
    // The workflow source has no Harness before its campaign; Factory instructions already exist in the issue source.
    const absentHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${workflowProjectId}/harness`);
    assert.equal(absentHarness.observation.status, "absent");
    const unauthorizedHarness = await fetch(`${apiUrl}/api/projects/${profileProjectId}/harness/refresh`, { method: "POST" });
    assert.equal(unauthorizedHarness.status, 403);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: `Detalle operativo de ${profileProjectId}`, exact: true }).click();
    const harnessPanel = page.getByRole("region", { name: "Harness del proyecto" });
    await harnessPanel.getByTestId("harness-status").getByText("healthy", { exact: true }).waitFor();
    const refreshHarnessResponse = await observeResponse(page, `/api/projects/${profileProjectId}/harness/refresh`, "POST", () => harnessPanel.getByRole("button", { name: "Actualizar Harness", exact: true }).click());
    assert.equal(refreshHarnessResponse.status(), 200);
    await harnessPanel.getByTestId("harness-saved").getByText(/Última observación guardada/).waitFor();
    assert.equal(await harnessTreeHash(harnessProjectRoot), beforeHarness, "read and refresh leave all project bytes unchanged");
    const savedHarness = (await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`)).saved!;
    assert.equal(savedHarness.status, "healthy", "explicit refresh persists the healthy observation");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await harnessPanel.getByRole("button", { name: "Actualizar Harness" }).evaluate((element) => element.getBoundingClientRect().width < 220), "Harness refresh control remains compact");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Harness detail has no mobile horizontal overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await reads.navigate(() => page.reload({ waitUntil: "domcontentloaded" }));
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: `Detalle operativo de ${profileProjectId}` }).click();
    await page.getByTestId("harness-saved").getByText(/Última observación guardada/).waitFor();
    // These mutations create explicit disposable invalid/drift fixtures; inspection must not repair them.
    const routingPath = join(harnessProjectRoot, ".agents/orchestration/ROUTING.md");
    const routingBytes = await readFile(routingPath);
    await writeFile(routingPath, "Synthetic invalid routing.\n");
    const invalidHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`);
    assert.equal(invalidHarness.observation.status, "invalid");
    assert.deepEqual(await readFile(routingPath), Buffer.from("Synthetic invalid routing.\n"));
    const invalidRefresh = await fetch(`${apiUrl}/api/projects/${profileProjectId}/harness/refresh`, { method: "POST", headers: { "x-surtec-session": firstSessionToken } });
    assert.equal(invalidRefresh.status, 200, "saving an invalid observation does not repair its scaffold");
    await page.getByRole("button", { name: "Hoy", exact: true }).click();
    const harnessSignalCard = page.locator(".today-signal").filter({ hasText: "Harness: H1-H4 routing structure is missing or invalid." });
    await harnessSignalCard.getByRole("button", { name: "Ver Harness", exact: true }).click();
    await page.getByTestId("harness-status").getByText("invalid", { exact: true }).waitFor();
    assert.equal(await page.locator(".today-signal").count(), 0, "Harness evidence navigation opens dashboard detail, not the editor");
    await writeFile(routingPath, routingBytes);
    const restoredRefresh = await fetch(`${apiUrl}/api/projects/${profileProjectId}/harness/refresh`, { method: "POST", headers: { "x-surtec-session": firstSessionToken } });
    assert.equal(restoredRefresh.status, 200);
    const restoredSavedHarness = (await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`)).saved!;
    const sourcePrimerPath = join(canonicalRoot, "AGENTS.md");
    const sourcePrimerBytes = await readFile(sourcePrimerPath);
    await writeFile(sourcePrimerPath, "Synthetic canonical drift.\n");
    const untrustedHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`);
    assert.equal(untrustedHarness.observation.comparison, "unknown");
    assert.equal(untrustedHarness.observation.canonical_version, null);
    await writeFile(sourcePrimerPath, sourcePrimerBytes);
    assert.equal(await harnessTreeHash(harnessProjectRoot), beforeHarness);
    assert.deepEqual((await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`)).saved, restoredSavedHarness, "GET unknown observations do not replace explicitly restored saved evidence");

    const workflows = await workflowCampaign({ page, apiUrl, dashboardUrl, root: tempRoot, stateRoot, projectsRoot,
      post: (path, body) => apiPost(path, body, firstSessionToken, 30_000), effects: (label) => effects(30_000, label), drainReads: (label) => reads!.drain(30_000, label),
      stage: (value) => { stage = value; console.log(value); } });
    // A test-owned terminal snapshot deliberately has no event for its newer
    // revision. Reads/restart must expose uncertainty, never repair or replay.
    const historySource = await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${analysisId}`);
    const historyFixture = await prepareHistoryFixture(stateRoot, historySource.envelope);
    const { historyTaskId, historyTask } = historyFixture;
    const historyBefore = await readApiJson<import("../lib/state/types").TaskDetailModel>(`${apiUrl}/api/tasks/${historyTaskId}/detail`);
    assert.deepEqual(historyBefore.task, historyTask, "snapshot remains authoritative before restart with partial history");
    assert.deepEqual(historyBefore.events.map((event) => event.revision), [1], "detail never invents a missing event");
    const beforeWorkflowRestart = await effects();
    stage = "restart the real API and verify durable state and session rotation";
    const initialSessionResponse = await readApiJson<{ token: string }>(`${apiUrl}/api/session`);
    assert.equal(initialSessionResponse.token, firstSessionToken, "browser and API share the same initial session token");
    const preRestartPreview = await previewRequest(analysisRequest);
    await reads.navigate(() => page.goto("about:blank"));
    const stopped = await stopApi(api);
    assert.ok(stopped, `isolated API process stops before restart (${api.output})`);
    api = null;
    await delay(250);
    api = startApi(port, stateRoot, projectsRoot);
    await waitForApi(api, apiUrl);
    const restartedSession = await readApiJson<{ token: string }>(`${apiUrl}/api/session`);
    assert.notEqual(restartedSession.token, firstSessionToken, "API restart rotates the in-memory session token");
    const staleTokenWrite = await fetch(`${apiUrl}/api/organization/company`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-surtec-session": firstSessionToken },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(staleTokenWrite.status, 403, "old browser token cannot mutate after API restart");
    const restartEffects = await effects();
    assert.equal((await apiPost("/api/tasks", { ...analysisDispatch, preview_fingerprint: preRestartPreview.fingerprint }, restartedSession.token)).status, 409, "restart invalidates issuance even with a fresh session");
    assert.deepEqual(await effects(), restartEffects, "unissued preview after restart causes no effects");
    assert.deepEqual((await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${analysisId}`)).envelope.context_manifest, defaultPreview.manifest, "recorded analysis manifest survives API restart");
    assert.deepEqual((await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`)).saved, restoredSavedHarness, "Harness observations survive API restart");
    const restartedOrganization = await readApiJson<{ company: { mission: string; operating_principles: string[] }; objectives: Array<Record<string, unknown>>; project_objectives: Record<string, { objective_ids: string[]; primary_objective_id: string | null }> }>(`${apiUrl}/api/organization`);
    assert.equal(restartedOrganization.company.mission, "Synthetic local acceptance mission.", "company profile survives API restart");
    assert.deepEqual(restartedOrganization.company.operating_principles, ["Keep local test data isolated.", "Preserve source records."]);
    assert.ok(restartedOrganization.objectives.some((objective) => objective.id === activeObjective.id), "objectives survive API restart");
    assert.deepEqual(restartedOrganization.project_objectives[profileClientId]?.objective_ids, [String(activeObjective.id)], "project links survive API restart");
    const stableProfiles = await readApiJson<{ profiles: MigratedProfile[]; migration: MigrationReport | null }>(`${apiUrl}/api/portfolio/profiles`);
    assert.equal(stableProfiles.migration, null, "already-migrated profiles do not migrate twice");
    assert.equal(stableProfiles.profiles.length, 2);
    const persistedIssues = await readApiJson<{ issues: Array<{ id: string; status: string; work_scale: string; scope_revision: number }> }>(`${apiUrl}/api/work-issues`);
    const legacyIssueIds = [issueCreateBody.issue.id, ...scopeOutcomes.map((issue) => issue.id)];
    assert.deepEqual(persistedIssues.issues.filter((issue) => legacyIssueIds.includes(issue.id)).map((issue) => ({ id: issue.id, status: issue.status, work_scale: issue.work_scale, scope_revision: issue.scope_revision })), [
      { id: issueCreateBody.issue.id, status: "done", work_scale: "trivial", scope_revision: 1 },
      ...scopeOutcomes.map((issue) => ({ ...issue, work_scale: "trivial" })),
    ], "local issue and authorization survive API restart without any provider write");
    assert.deepEqual(await effects(), beforeWorkflowRestart, "workflow gates, completed handoffs, stopped tasks and counters survive restart without replay");
    for (const record of workflows.records) assert.deepEqual(await workflows.detail(record.workflow.id), record, "restart retains exact stage/task/grant/receipt/accounting identities");
    const persistedOrganization = JSON.parse(await readFile(join(stateRoot, "organization", "organization.json"), "utf8")) as { schema_version?: number };
    assert.equal(persistedOrganization.schema_version, 1, "organization state remains in its supported versioned format");

    await reads.navigate(() => page.goto(`${dashboardUrl}/`, { waitUntil: "domcontentloaded" }));
    await page.getByText("Cockpit diario").waitFor();
    await page.getByRole("button", { name: "SURTEC", exact: true }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Misión").inputValue(), "Synthetic local acceptance mission.", "dashboard reload after API restart shows persisted company data");
    await objectiveCard("Synthetic active objective").waitFor();
    await objectiveCard("Synthetic active objective").getByText(`Proyectos: ${profileClientId}`, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await page.locator(".work-issue-card").filter({ hasText: "Synthetic local issue proposal" }).getByText("done", { exact: true }).waitFor();
    const restartedLineage = await readApiJson<import("../lib/issues/types").IssueLineage>(`${apiUrl}/api/work-issues/${issueCreateBody.issue.id}`);
    await assertOriginalReplay(restartedLineage.issue, restartedSession.token);
    assert.deepEqual(restartedLineage.candidates, doneLineage.candidates, "immutable candidate survives API restart unchanged");
    assert.deepEqual(restartedLineage.evidence, doneLineage.evidence, "verification/review evidence survives API restart unchanged");
    assert.deepEqual(restartedLineage.evidence_gaps, []);
    assert.equal(restartedLineage.tasks[0]!.executions.length, 1);
    assert.deepEqual(restartedLineage.tasks[0]!.task.envelope.context_manifest, issuePreview.manifest);
    assert.deepEqual(restartedLineage.tasks[0]!.task.testing_evidence, doneLineage.tasks[0]!.task.testing_evidence, "infrastructure receipt survives restart unchanged");
    assert.equal(restartedLineage.sessions[0]?.id, session.id, "linked session survives API restart");
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    stage = "F4 T004 retained snapshot and unavailable history after real API restart and browser reload";
    const assertHistory = () => assertRecordedHistory(page, historyFixture);
    await page.locator(".hist-row").getByRole("button", { name: historyTaskId, exact: true }).click();
    await assertHistory();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "history observation has no mobile overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await reads.navigate(() => page.reload({ waitUntil: "domcontentloaded" }));
    await page.getByText("Cockpit diario").waitFor();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator(".hist-row").getByRole("button", { name: historyTaskId, exact: true }).click();
    await assertHistory();
    const historyAfter = await readApiJson<import("../lib/state/types").TaskDetailModel>(`${apiUrl}/api/tasks/${historyTaskId}/detail`);
    assert.deepEqual(historyAfter, historyBefore, "new process reconstructs saved facts without inventing history");
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator(".hist-row").getByRole("button", { name: analysisId, exact: true }).click();
    await recordedManifest.getByText(defaultPreview.fingerprint, { exact: true }).waitFor();
    assert.ok(!(await recordedManifest.innerText()).includes(syntheticClient.confidential_notes), "recorded public manifest remains body-free after restart");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "recorded task manifest has no mobile overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    const pendingCard = page.locator("article.work-issue-card").filter({ hasText: workflows.pendingIssue.title });
    await pendingCard.getByRole("button", { name: "Ver workflow", exact: true }).click();
    const restartedPending = await workflows.detail(workflows.pendingId);
    await page.getByRole("region", { name: `Workflow de ${workflows.pendingIssue.title}`, exact: true }).getByText(/^plan-approval ·/).waitFor();
    assert.equal(restartedPending.stages.length, 1, "restart at Planner gate cannot admit an engineer");
    await workflows.stop(workflows.pendingIssue, restartedPending);
    assert.ok(browserErrors.length === 0 && browserHttpErrors.length === 0, `browser remains free of errors after API restart (${[...browserErrors, ...browserHttpErrors].join(" | ")})`);

    stage = "verify immediate browser evidence consistency after local acceptance";
    assert.equal(reviewLineageStale, false, "after acceptance the open lineage must refresh; it must not retain a missing-human-review gap while the issue is done");
    const executorEffects = (await readFile(join(tempRoot, "executor-effects.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { mode: string; fingerprint: string; workflow_id?: string });
    assert.deepEqual(executorEffects.filter((effect) => !effect.workflow_id).map((effect) => effect.mode), ["read-only", "workspace-write-verify", "workspace-write-verify", "workspace-write-verify"], "exactly four preserved v1 turns");
    assert.equal(executorEffects.length, 35, "exactly four v1 plus 31 governed turns including four recovered-plan roles; preview/refusal/restart/stop never adds a turn");
    assert.deepEqual(executorEffects, workflows.effects, "restart and gate cancellation never replay a role");
    assert.ok(executorEffects.every((effect) => /^[a-f0-9]{64}$/.test(effect.fingerprint)));
    assert.equal(execFileSync("git", ["-C", syntheticRepo, "status", "--porcelain"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), "", "source Git checkout remains clean");
    assert.equal(execFileSync("git", ["-C", workflowRepo, "status", "--porcelain"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), "", "workflow source checkout remains clean and unpublished");
    assert.equal(execFileSync("git", ["-C", workflowRepo, "rev-parse", "HEAD"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), workflowBaseline);
    assert.equal(execFileSync("git", ["-C", workflowRepo, "remote"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), "", "synthetic workflow Git has no publication destination");
    assert.ok(mutatingSessionHeaders.every(Boolean), "every workflow/dashboard mutation uses a local session");
    console.log("PASS real local API + Playwright dashboard: retained Planner recovery with distinct human gate, all five Phase O templates, exact Planner/risk/criteria gates, candidate-only Reviewer/QA, verified receipts, one bounded correction and second-correction refusal, stale/budget/tree guards, task ownership/full mobile evidence, active-role stop, restart/no replay/session rotation; prior Phase K-N migration/organization/Harness/context/issues retained; exactly 35 synthetic turns (4 v1 + 31 workflow), no paid runtime or provider writes.");
  } catch (error) {
    console.error(`Local dashboard smoke failed during: ${stage}`);
    const nodeFailure = nodeApiFailure(error);
    if (nodeFailure) console.error("SMOKE_NODE_API_FAILURE " + JSON.stringify(nodeFailure));
    const readActivity = reads?.deadlineActivity(error);
    if (readActivity) console.error("SMOKE_READ_ACTIVITY " + JSON.stringify(readActivity));
    const budgetReads = reads?.budgetDeadline(error);
    if (budgetReads?.length && readActivity?.label.startsWith("t013-")) {
      console.error("SMOKE_T013_BUDGET_READS " + JSON.stringify({ label: readActivity.label, browser_pending: budgetReads, proxy_totals: budgetProxyTrace.snapshot() }));
    }
    const readFailure = reads?.failureActivity(error);
    if (readFailure) console.error("SMOKE_READ_FAILURE " + JSON.stringify(readFailure));
    if (tempRoot) {
      const snapshot = await readFile(join(tempRoot, "state/workflows/workflows.json"), "utf8").catch(() => null);
      if (snapshot) {
        const facts = JSON.parse(snapshot) as { workflows: Record<string, WorkflowDetail["workflow"]>; stages: Record<string, WorkflowDetail["stages"][number]> };
        console.error("SYNTHETIC_WORKFLOW_FACTS " + JSON.stringify(Object.values(facts.workflows).map((owner) => ({ template: owner.template_id, status: owner.status,
          current_stage: owner.current_stage_id ? facts.stages[owner.current_stage_id]?.kind : null, counters: owner.counters, blocked_reason: owner.blocked_reason }))));
      }
    }
    throw error;
  } finally {
    if (reads) console.log(`SMOKE_BROWSER_READ_CANCELLATIONS ${reads.cancelledReads()}`);
    reads?.dispose();
    const cleanup = await cleanupSmoke({ browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: api ? () => stopApi(api!) : undefined, root: tempRoot });
    console.log(`SMOKE_CLEANUP ${JSON.stringify({ fixture_id: tempRoot ? basename(tempRoot) : null, ...cleanup })}`);
    if (!cleanup.workspace_removed) {
      console.error(`Temporary smoke workspace preserved for safety: ${tempRoot ?? "not created"}; API stopped: ${cleanup.api_stopped}`);
      throw new Error("Synthetic smoke cleanup did not complete");
    } else {
      console.log("Temporary synthetic API state and repositories cleaned up.");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
