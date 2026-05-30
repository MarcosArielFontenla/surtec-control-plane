# Surtec Control Plane — Branch Ops (list / switch / create) (v1) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** Branch operations from the project card (theme B "actions from one place", slice B.4)
- **Builds on:** git sync (`2026-05-30-git-sync-design.md`), project open actions
  (`2026-05-30-project-open-actions-design.md`), portfolio discovery (`2026-05-29-portfolio-discovery-design.md`)

## 1. Context & Goal

The dashboard can already Fetch/Pull/Push a project (B.3). This slice adds **branch operations on the MAIN
checkout** from the card: **list** local branches, **switch** to an existing one, and **create** a new one.
It's the next step in "act on a project without opening a terminal." Switching is blocked while the working
tree is dirty (clear, predictable); creating is always allowed (it carries any changes to the new branch).
Remote/tracking branches, choosing a base commit, open-terminal, and bulk ops are explicit later slices.

## 2. Key Decisions

- **Branch names are user input** — the first slice where the "action" is not a fixed allowlist key. This is
  the central new risk. Mitigations:
  - **`validateBranchName(name)`** (strict, pure): allow only `[A-Za-z0-9._/-]`; reject names that start with
    `-` (prevents git **argument injection** like `--force`/`-d`), start with `.` or `/`, end with `/` or
    `.lock`, contain `..`, are empty, or exceed 200 chars.
  - **Switch additionally requires** the requested name to be IN the project's real local branch list
    (defense in depth — a switch target must exist).
  - All git runs via `spawnSync("git", argv)` with **no `shell`**, so the name is a single argv element with
    no shell-metacharacter interpretation. Validation + the leading-`-` rejection close argument injection.
- **Dirty-tree guard, server-enforced:** `switchBranch` runs `git status --porcelain` first; if the tree is
  dirty it refuses with `{ ok:false, output:"working tree no está limpio…" }` WITHOUT attempting the switch.
  The UI also disables switch when `git.dirty`, but the server guard is authoritative (not client-trusting).
  **Create is exempt** (`git switch -c` carries changes to the new branch — never loses anything).
- **Create = create + switch** from the current HEAD (`git switch -c <name>`); no base-commit picker (YAGNI).
- **Local branches only** in v1 (no remote/tracking branches).
- **A failed/refused op is a `200` result `{ok:false, output}`**, not an HTTP error (consistent with B.3).
  HTTP errors are only invalid op / invalid name (400) and unknown project (404).
- **Cache invalidation:** a successful switch/create changes the current branch → invalidate the git-status
  cache entry for that path so the next `/api/overview` poll (~3s) shows the new branch + recomputed
  ahead/behind (reuses `GitStatusCache.invalidate` from B.3).

## 3. Scope

**In scope (v1):**

- `dashboard/src/server/git-branch.ts` — `validateBranchName`, `listBranches`, `switchBranch`,
  `createBranch`, `BranchError`. Discovery-based path resolution (inline, like `git-sync.ts`); never throws
  except the typed `BranchError`.
- `dashboard/src/server/index.ts` — `GET /api/projects/:id/branches`, `POST /api/projects/:id/branch`;
  invalidate cache on a successful switch/create.
- `dashboard/src/ui/api.ts` — `getBranches(id)`, `branchOp(id, op, name)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — a `BranchControl` sub-component (toggle panel: branch list
  with switch, a create input, result banner, dirty note).
- `dashboard/src/ui/styles/dashboard.css` — minor styles for the branch panel.

**Out of scope (later):** remote/tracking branches; delete/rename branch; choosing a base commit/branch when
creating; open terminal; bulk branch ops across repos; `push -u`; stash; a refactor extracting the shared
discovery→path resolution (noted follow-up).

## 4. Architecture

```
List (read):
  open BranchControl → api.getBranches(id) → GET /api/projects/:id/branches
    listBranches(repoRoot, id):
      proj = discover(root, ignore).find(p => p.id === id)   // server-side path; never a client path
      if !proj → BranchError("unknown project", 404)
      out = git -C proj.path branch --format=%(refname:short)
      cur = git -C proj.path rev-parse --abbrev-ref HEAD
      → { branches: string[], current: string|null }

Switch / Create (write):
  click branch / submit name → api.branchOp(id, op, name) → POST /api/projects/:id/branch { op, name }
    if op ∉ {switch,create} → BranchError(400)
    if !validateBranchName(name) → BranchError("invalid branch name", 400)
    proj = discover(...).find(...) ; if !proj → BranchError(404)
    switch:
      if `git status --porcelain` non-empty → { ok:false, output:"working tree no está limpio…" }   // no switch attempted
      if name ∉ listBranches(...).branches → { ok:false, output:"branch no existe: <name>" }
      r = git -C path switch <name>            → { ok, output }
    create:
      r = git -C path switch -c <name>         → { ok, output }
    on ok → gitStatusCache.invalidate(proj.path)
    → 200 { ok, output }
```

`spawnSync` and `discover` are injectable (`deps`) so every function is unit-testable without running git.

## 5. Components

### `dashboard/src/server/git-branch.ts`

```ts
export class BranchError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "BranchError"; }
}

export type BranchOp = "switch" | "create";
export interface BranchListResult { branches: string[]; current: string | null }
export interface BranchOpResult { ok: boolean; output: string }

export function validateBranchName(name: string): boolean;
export function listBranches(repoRoot: string, id: string, deps?: GitBranchDeps): BranchListResult;
export function switchBranch(repoRoot: string, id: string, name: string, deps?: GitBranchDeps): BranchOpResult;
export function createBranch(repoRoot: string, id: string, name: string, deps?: GitBranchDeps): BranchOpResult;
```

- `validateBranchName`: returns false for empty, length > 200, starting with `-`/`.`/`/`, ending with `/` or
  `.lock`, containing `..`, or any char outside `[A-Za-z0-9._/-]`. (Stricter than git's own rules — a safe
  subset. Pure; never throws.)
- `GitBranchDeps { spawnSync?, discover?, root? }` — same shape/defaults as `git-sync.ts`
  (`spawnSync = child_process.spawnSync`, `discover = discoverProjects`,
  `root = SURTEC_PROJECTS_ROOT ?? dirname(repoRoot)`, ignore = `DEFAULT_IGNORE + SURTEC_PROJECTS_IGNORE`).
- `listBranches`: resolve path (unknown → `BranchError(404)`); run `git -C path branch --format=%(refname:short)`
  → split/trim/filter to `branches`; run `git -C path rev-parse --abbrev-ref HEAD` → `current` (null if it
  returns `HEAD`/empty/non-zero). A git failure yields `{ branches: [], current: null }` (never throws here).
- `switchBranch`: resolve path (404). Run `git -C path status --porcelain`; if stdout is non-empty →
  `{ ok:false, output:"working tree no está limpio; commiteá o descartá los cambios para cambiar de branch" }`
  (no switch attempted). Else if `name` not in `listBranches(...).branches` →
  `{ ok:false, output:"la branch no existe: " + name }`. Else `r = spawnSync("git", ["-C", path, "switch", name], …)`;
  return `{ ok: r.status===0 && !r.error, output: tail(stdout+stderr+err) }`.
  (Name validation is done at the route before calling; `switchBranch` re-checks membership.)
- `createBranch`: resolve path (404). `r = spawnSync("git", ["-C", path, "switch", "-c", name], …)`;
  return `{ ok, output }`. (Name validity enforced at the route; `-c` takes `name` as its positional value.)
- Shared `spawnSync` opts: `{ encoding:"utf8", timeout:30_000 }`; `output` combined + `.trim().slice(-4000)`
  (mirror `git-sync.ts`, incl. the `string|Buffer` guard).

### `dashboard/src/server/index.ts`

```ts
app.get("/api/projects/:id/branches", (c) => {
  try { return c.json(listBranches(repoRoot, c.req.param("id"))); }
  catch (err) {
    if (err instanceof BranchError) return c.json({ error: err.message }, err.status as 404);
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/projects/:id/branch", async (c) => {
  let body: { op?: string; name?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const id = c.req.param("id");
  const op = String(body?.op ?? ""); const name = String(body?.name ?? "");
  if (op !== "switch" && op !== "create") return c.json({ error: `invalid op: ${op}` }, 400);
  if (!validateBranchName(name)) return c.json({ error: `invalid branch name: ${name}` }, 400);
  try {
    const result = op === "switch"
      ? switchBranch(repoRoot, id, name)
      : createBranch(repoRoot, id, name);
    if (result.ok) {
      const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
      const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
      const proj = discoverProjects(root, ignore).find((p) => p.id === id);
      if (proj) gitStatusCache.invalidate(proj.path);
    }
    return c.json(result);
  } catch (err) {
    if (err instanceof BranchError) return c.json({ error: err.message }, err.status as 400 | 404);
    return c.json({ error: (err as Error).message }, 500);
  }
});
```
- `dirname`, `discoverProjects`, `DEFAULT_IGNORE`, `gitStatusCache` are already in scope in `createApp`
  (reused exactly as B.3 does). The name is validated at the route (400) before any git runs.

### `dashboard/src/ui/api.ts`

```ts
export async function getBranches(id: string): Promise<{ branches: string[]; current: string | null }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/branches`);
  if (!res.ok) throw new Error(`branches failed: ${res.status}`);
  return (await res.json()) as { branches: string[]; current: string | null };
}

export async function branchOp(
  id: string, op: "switch" | "create", name: string,
): Promise<{ ok: boolean; output: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/branch`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, name }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `branch ${op} failed: ${res.status}`);
  }
  return (await res.json()) as { ok: boolean; output: string };
}
```

### `dashboard/src/ui/components/ProjectCard.tsx` — `BranchControl` sub-component

- Render only when `project.git?.ok`. A button `Branch: {current ?? "(detached)"}` toggles an open panel.
- State: `open`, `branches: string[]`, `current: string | null`, `loading`, `busy: string | null`,
  `result: { ok; text } | null`, `newName: string`.
- On open → `getBranches(project.id)` populates `branches`/`current` (and a `loading` state).
- Each branch row: current is marked (e.g. `● {name}`, no button); others are a button that calls
  `branchOp(project.id, "switch", name)` — **disabled when `project.git.dirty`** (with a note
  "árbol sucio: commiteá o descartá para cambiar de branch") or while `busy`.
- A create row: a text input bound to `newName` + a **Crear** button calling
  `branchOp(project.id, "create", newName)`; the button disabled when `newName` is empty/whitespace or `busy`.
- After any op: show `result` in a banner (`--ok`/`--warn`), then re-`getBranches` to refresh the list
  (the git-line refreshes via the overview poll). Errors from a thrown `branchOp` (400 invalid) → warn banner.
- The panel reuses `.es-banner`, `.es-btn`; a small `.es-branches` / `.es-branches__list` style is added.

## 6. Data Flow & State Transitions

No persisted state. `getBranches` is read-on-demand (panel open), not polled. A switch/create is one-shot;
on success the server invalidates the cache so `/api/overview` reflects the new current branch on the next
poll. The panel's `branches`/`current` are local UI state refreshed after each op. No change to
dispatch/Procesos/review/git-sync.

## 7. Safety & Governance

- **Branch name is the only user-supplied free value.** It is validated at the route (`validateBranchName`)
  before any git runs, never starts with `-` (no flag/argument injection), and is passed as a single argv
  element to `spawnSync("git", …)` with no `shell`. Switch additionally requires the name to be a real local
  branch.
- **Switch is blocked when the tree is dirty** (server-enforced via `git status --porcelain` BEFORE
  switching; UI also disables it). Create never loses changes (`switch -c` carries them).
- **No outward-facing action** — branch list/switch/create are entirely local; nothing is pushed or fetched
  here (push stays in B.3, gated by its own confirm). 30s timeout bounds hangs.
- Local-only developer tooling on the user's own repos; no agent, no network, no secrets.

## 8. Error Handling

- Invalid op or invalid name → `400` (route, before git). Unknown project → `BranchError` `404`.
- Dirty tree on switch → `200 { ok:false, output }` (refusal is a result). Switch to a non-existent branch →
  `200 { ok:false, output }`. Any git failure (e.g. a create with a name that already exists) →
  `200 { ok:false, output }` with git's message. `listBranches`/`switchBranch`/`createBranch` never throw
  except the typed `BranchError`.
- The UI `getBranches`/`branchOp` throw only on a non-2xx HTTP; caught and shown in the panel's banner.

## 9. Testing (TDD)

- `dashboard/src/server/git-branch.test.ts`:
  - `validateBranchName`: accepts `feature/x`, `fix-1`, `release_2.0`, `a/b/c`; rejects ``, `-foo`,
    `--force`, `.hidden`, `/abs`, `feat..x`, `ends/`, `wip.lock`, `has space`, `tab\tname`, `a~b`, `a:b`,
    `a?b`, and a 201-char string.
  - `listBranches`: injected `spawnSync` returning `"main\ndev\nfeature/x\n"` for the list and `"dev\n"` for
    `rev-parse` → `{ branches:["main","dev","feature/x"], current:"dev" }`; unknown project (discover `[]`) →
    throws `BranchError` 404; a failing git → `{ branches:[], current:null }` (no throw).
  - `switchBranch`: dirty (porcelain returns `" M file\n"`) → `{ ok:false }`, output mentions "no está limpio",
    and `git switch` is NOT spawned; name not in branch list → `{ ok:false }` "no existe", switch not spawned;
    clean + existing name → spawns `["-C", path, "switch", "dev"]` and returns `{ ok:true, output }`.
  - `createBranch`: clean/dirty alike → spawns `["-C", path, "switch", "-c", "feature/y"]` → `{ ok:true }`;
    git exit≠0 (name exists) → `{ ok:false, output }` (no throw); unknown project → `BranchError` 404.
- `dashboard/src/server/index.test.ts`:
  - `POST /api/projects/:id/branch` invalid op → 400; invalid name (`-x`) → 400; invalid JSON → 400; unknown
    project with a VALID op+name (pin `SURTEC_PROJECTS_ROOT` to an empty temp dir) → 404.
  - `GET /api/projects/:id/branches` for an unknown project (empty root) → 404.
  - (The switch/create success path is covered in `git-branch.test.ts` with injected spawnSync — no real git.)
- `dashboard/src/ui/components/ProjectCard.test.tsx`:
  - opening the panel calls `getBranches` (stub) and lists the branches, marking current;
  - clicking a non-current branch POSTs `branchOp(id,"switch",name)` (stub fetch);
  - when `git.dirty`, the switch buttons are disabled;
  - typing a name + Crear POSTs `branchOp(id,"create",name)`; Crear is disabled for an empty name;
  - a non-git project renders no BranchControl.

## 10. Evolution Path

- Remote/tracking branches; delete/rename; create-from-a-chosen-base; `push -u` after creating a branch.
- Open terminal at the project path; bulk branch ops; stash before switching when dirty.
- Extract the shared discovery→path resolution helper used by open-project / git-sync / git-branch.
- Use `git switch --end-of-options <name>` as extra hardening (validation already covers it).

## 11. Open Questions

None blocking. `git` is on PATH (used throughout). The dirty guard uses `git status --porcelain`; a brand-new
branch name that already exists fails cleanly via git's own message. `validateBranchName` is intentionally
stricter than git's ref rules — if a legitimate name is rejected, loosening the regex is a one-line change.
