# Surtec Control Plane — Project "Open" Actions (v1) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** Project open actions (theme B "actions from one place", slice B.1)
- **Builds on:** portfolio discovery (`2026-05-29-portfolio-discovery-design.md`)

## 1. Context & Goal

Marcos opens his projects one by one via CLI / VS Code. The dashboard now shows his real portfolio; this
slice lets him **act on a project from the card**: open it in **VS Code**, open its **folder** in the OS
file explorer, or open it **on GitHub** — without hunting for it. The Hono server runs on his machine, so
it can spawn `code` / the file explorer; GitHub is a plain web link. This is the first of several theme-B
"actions" slices (running dev/build/test and git pull/push come later).

## 2. Key Decisions

- **GitHub is a pure client-side link** (no server): a function converts the project's git remote into a
  `https://github.com/owner/repo` URL; the card renders an `<a target="_blank" rel="noreferrer">`. Non-GitHub
  or missing remote → no link.
- **VS Code / Folder are server-spawned** via `POST /api/projects/:id/open` `{ target }`. The client sends
  ONLY the project `id` (a folder name) — never a path. The server **re-runs discovery**, resolves the
  project's real path, validates `target` against a fixed allowlist, and spawns a **fixed binary** with the
  validated path as the only argument. No client-supplied path, no shell injection — the worst possible
  outcome is opening one of the user's own discovered folders.
- **No confirmation dialog** — opening an editor/folder is a local, reversible convenience (unlike
  approve/push). Errors (e.g. `code` not on PATH) are reported, never thrown.
- **Editor is configurable** via `SURTEC_EDITOR_CMD` (default `code`), so Cursor/others work.
- **Cross-platform** command selection is a pure function; the spawn is mocked in tests.

## 3. Scope

**In scope (v1):**

- `lib/github-url.ts` — `githubWebUrl(remote)` (pure; git@ / https / ssh forms; non-GitHub → null).
- `dashboard/src/server/open-project.ts` — `resolveOpenCommand(target, path, platform, editorCmd)` (pure)
  + `openProject(repoRoot, id, target, deps?)` (validate via discovery, spawn; never throws) + `OpenError`.
- `dashboard/src/server/index.ts` — `POST /api/projects/:id/open`.
- `dashboard/src/ui/api.ts` — `openProject(id, target)`.
- `dashboard/src/ui/components/ProjectCard.tsx` — an actions row: **VS Code** · **Carpeta** buttons +
  **GitHub** link.

**Out of scope (later B slices):** running dev/build/test from the dashboard (long-lived processes +
output streaming); git pull/push/branch; open terminal; bulk actions across repos; surfacing the git
remote for unconfigured projects (today the GitHub link uses the registry `repo`, which is set for all
configured projects).

## 4. Architecture

```
GitHub (client only):
  ProjectCard: href = githubWebUrl(p.repo); render <a> only when non-null.

VS Code / Folder (server):
  Button → api.openProject(id, target) → POST /api/projects/:id/open { target }
    openProject(repoRoot, id, target):
      if target ∉ {"vscode","folder"} → OpenError (400)
      discovered = discoverProjects(SURTEC_PROJECTS_ROOT ?? dirname(repoRoot), ignore)
      proj = discovered.find(p => p.id === id)
      if !proj → OpenError("unknown project", 404)
      { command, args, shell } = resolveOpenCommand(target, proj.path, process.platform, editorCmd)
      const r = spawn(command, args, { detached: true, stdio: "ignore", shell }); r.unref?.()
      on spawn error → OpenError(message, 500); else → { ok: true }
```

`spawn` and `process.platform`/`editorCmd` are injectable (`deps`) so `openProject` is unit-testable
without launching anything. Discovery reuse keeps the path trusted; the command is a fixed binary.

## 5. Components

### `lib/github-url.ts`
```ts
export function githubWebUrl(remote: string | null | undefined): string | null;
```
- `git@github.com:owner/repo(.git)?` → `https://github.com/owner/repo`
- `https://github.com/owner/repo(.git)?` (and `http://`) → `https://github.com/owner/repo`
- `ssh://git@github.com/owner/repo(.git)?` → `https://github.com/owner/repo`
- Trailing `/`, `.git`, and credentials are stripped. Anything not on `github.com`, or null/empty → `null`.
- Pure; never throws.

### `dashboard/src/server/open-project.ts`
```ts
export class OpenError extends Error { constructor(message: string, public status: number) { super(message); } }

export type OpenTarget = "vscode" | "folder";

export function resolveOpenCommand(
  target: OpenTarget, path: string, platform: NodeJS.Platform, editorCmd: string,
): { command: string; args: string[]; shell: boolean };

export interface OpenDeps {
  spawn?: (command: string, args: string[], opts: object) => { on?: (e: string, cb: (err: Error) => void) => void; unref?: () => void };
  platform?: NodeJS.Platform;
  editorCmd?: string;
  discover?: (root: string, ignore?: string[]) => { id: string; path: string }[];
  root?: string;
}

export function openProject(repoRoot: string, id: string, target: string, deps?: OpenDeps): { ok: true };
```
- `resolveOpenCommand`:
  - `vscode` → `{ command: editorCmd, args: [path], shell: platform === "win32" }` (shell on Windows so a
    `.cmd` shim like `code.cmd`/`cursor.cmd` resolves; Node escapes the args for cmd.exe).
  - `folder` → win32 `{ command: "explorer", args: [path], shell: false }`; darwin `{ "open", [path], false }`;
    else `{ "xdg-open", [path], false }`.
- `openProject`:
  - `target` not in the allowlist → throw `OpenError("invalid target: " + target, 400)`.
  - resolve `root = deps.root ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot)`, discover with the
    same `DEFAULT_IGNORE + SURTEC_PROJECTS_IGNORE` as `/api/overview`.
  - project not found → `OpenError("unknown project: " + id, 404)`.
  - resolve the command; `try { const child = spawn(...); child.unref?.() } catch (e) { throw new OpenError((e as Error).message, 500) }`.
  - return `{ ok: true }`.
  - Defaults: `spawn = child_process.spawn`, `platform = process.platform`,
    `editorCmd = process.env.SURTEC_EDITOR_CMD ?? "code"`, `discover = discoverProjects`.

### `dashboard/src/server/index.ts`
```ts
app.post("/api/projects/:id/open", async (c) => {
  let body: { target?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  try {
    return c.json(openProject(repoRoot, c.req.param("id"), String(body?.target ?? ""))); // { ok: true }
  } catch (err) {
    if (err instanceof OpenError) return c.json({ error: err.message }, err.status as 400 | 404 | 500);
    return c.json({ error: (err as Error).message }, 500);
  }
});
```

### `dashboard/src/ui/api.ts`
```ts
export async function openProject(id: string, target: "vscode" | "folder"): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/open`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `open failed: ${res.status}`);
  }
}
```

### `dashboard/src/ui/components/ProjectCard.tsx`
- Import `githubWebUrl` and `openProject`. Local `const [err, setErr] = useState<string|null>(null)`.
- An actions row (`.es-card__actions`, small): a **VS Code** button and a **Carpeta** button that call
  `openProject(p.id, "vscode"|"folder").catch(e => setErr(e.message))`; plus a **GitHub** `<a className="es-link">`
  rendered only when `githubWebUrl(p.repo)` is non-null (`target="_blank" rel="noreferrer"`).
- Buttons are `.es-btn--ghost es-btn` (small). A failed open shows a tiny `.es-banner es-banner--danger` line.
- (The card becomes a small stateful component — acceptable; it already only renders a `ProjectView`.)
- Add `.es-card__actions { display:flex; gap: var(--sp-2); flex-wrap:wrap; align-items:center; }` and
  `.es-link { font-size: var(--fs-body-sm); color: var(--ink); text-decoration: none; }` to `dashboard.css`.

## 6. Data Flow & State Transitions

No persisted state. Opening is a fire-and-forget local side effect; the server returns `{ ok: true }` once
the process is spawned (it does not wait for the editor). The GitHub link is derived per render from
`p.repo`. No change to overview/dispatch/review.

## 7. Safety & Governance

- **The client never supplies a path** — only an `id` that must match a freshly discovered project; the
  server owns the path. The command is a fixed binary from a 2-value `target` allowlist with the validated
  path as the sole argument. No shell string is built from client input.
- **Local-only, reversible** convenience action (opens an editor/explorer window). No network, no git, no
  agent, no secrets. No protected-branch or dispatch interaction.
- Spawn is `detached` + `stdio: "ignore"` + `unref()` so it never blocks or ties the server to the child;
  failures are returned as errors, never thrown out of the handler.

## 8. Error Handling

`githubWebUrl` returns `null` on anything unparseable. `openProject` throws a typed `OpenError` with a
status (400 invalid target, 404 unknown project, 500 spawn failure); the endpoint maps it. The UI catches
the thrown error and shows it inline on the card.

## 9. Testing (TDD)

- `lib/github-url.test.ts`: git@ / https / http / ssh forms, with and without `.git` and trailing slash →
  the canonical `https://github.com/owner/repo`; a GitLab/other host → `null`; `null`/empty → `null`.
- `dashboard/src/server/open-project.test.ts`:
  - `resolveOpenCommand("vscode", "/p", "win32", "code")` → `{ command:"code", args:["/p"], shell:true }`;
    `"darwin"` → `shell:false`; custom `editorCmd:"cursor"` honored.
  - `resolveOpenCommand("folder", ...)` per platform → `explorer`/`open`/`xdg-open`, `shell:false`.
  - `openProject` with an injected `discover` returning `[{id:"alpha",path:"/p/alpha"}]` + an injected
    `spawn` spy: target `"vscode"` → spawn called with `("code", ["/p/alpha"], { detached, stdio, shell })`;
    unknown id → throws `OpenError` status 404, spawn NOT called; invalid target → `OpenError` 400, no spawn;
    a `spawn` that throws → `OpenError` 500.
- `dashboard/src/server/index.test.ts`: `POST /api/projects/:id/open` exercises ONLY the non-spawning
  paths so no real editor launches — `404` for an unknown id (pin `SURTEC_PROJECTS_ROOT` to an empty temp
  dir so discovery finds nothing) and `400` for an invalid target. The spawn-success (`200 { ok: true }`)
  path is covered in `open-project.test.ts` with an injected spawn, not here.
- `dashboard/src/ui/components/ProjectCard.test.tsx`: a project with a GitHub `repo` renders a GitHub link
  with the right href; without `repo` → no link; clicking **VS Code** POSTs to `/api/projects/:id/open`
  with `{ target: "vscode" }` (stub `fetch`); a failed open shows the error text.

## 10. Evolution Path

- Run dev/build/test from the dashboard (stream output) — theme B.2.
- Git pull/push/branch; open terminal; bulk actions.
- Surface the live git remote for unconfigured projects so the GitHub link works before configuration.
- Per-OS terminal open; a configurable command palette per project.

## 11. Open Questions

None blocking. `code` must be on PATH (VS Code's "Install 'code' command in PATH"); if absent the action
returns a clear error. The endpoint test avoids spawning a real editor by exercising the non-spawn error
paths and a harmless injected command; the real spawn wiring is unit-tested with an injected spawn.
