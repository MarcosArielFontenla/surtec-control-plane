import { basename, dirname, join, resolve } from "node:path";

export function stateDir(): string {
  return process.env.SURTEC_STATE_DIR ?? join(process.cwd(), "state");
}

export function fixturesDir(): string {
  return process.env.SURTEC_FIXTURES_DIR ?? join(process.cwd(), "fixtures");
}

export function tasksDir(base: string = stateDir()): string {
  return join(base, "tasks");
}

export function projectsDir(base: string = stateDir()): string {
  return join(base, "projects");
}

export function eventsDir(base: string = stateDir()): string {
  return join(base, "events");
}

export function locksDir(base: string = stateDir()): string {
  return join(base, "locks");
}

export function notesDir(base: string = stateDir()): string {
  return join(base, "notes");
}

export function portfolioDir(base: string = stateDir()): string {
  return join(base, "portfolio");
}

export function portfolioProfilesPath(base: string = stateDir()): string {
  return join(portfolioDir(base), "projects.json");
}

export function clientPortfolioPath(base: string = stateDir()): string {
  return join(portfolioDir(base), "clients.json");
}

export function signalHumanStatePath(base: string = stateDir()): string {
  return join(base, "signals", "human-state.json");
}

export function workSessionsPath(base: string = stateDir()): string {
  return join(base, "sessions", "work-sessions.json");
}

export function organizationStatePath(base: string = stateDir()): string {
  return join(base, "organization", "organization.json");
}

export function issueStatePath(base: string = stateDir()): string {
  return join(base, "issues", "issues.json");
}

export function workflowStatePath(base: string = stateDir()): string {
  return join(base, "workflows", "workflows.json");
}

export function budgetsDir(base: string = stateDir()): string {
  return join(base, "budgets");
}

export function budgetStatePath(base: string = stateDir()): string {
  return join(budgetsDir(base), "budgets.json");
}

export function routinesDir(base: string = stateDir()): string {
  return join(base, "routines");
}

export function routineStatePath(base: string = stateDir()): string {
  return join(routinesDir(base), "routines.json");
}

export function harnessProfilesPath(base: string = stateDir()): string {
  return join(base, "harness", "profiles.json");
}

// Control/ownership files are outside the replaceable operating-state catalog.
export function maintenanceDir(base: string = stateDir()): string { return join(base, "maintenance"); }
export function maintenanceControlPath(base: string = stateDir()): string { return join(maintenanceDir(base), "control.json"); }
export function maintenanceGatePath(base: string = stateDir()): string { return join(maintenanceDir(base), "boundary.lock"); }
export function maintenanceOwnersDir(base: string = stateDir()): string { return join(maintenanceDir(base), "owners"); }

/** Canonical layouts use their parent state root; a legacy flat override owns itself. */
export function stateRootForStoreDirectory(directory: string, kind: string): string {
  const absolute = resolve(directory), folder = basename(absolute);
  const matches = process.platform === "win32" ? folder.toLowerCase() === kind.toLowerCase() : folder === kind;
  return matches ? dirname(absolute) : absolute;
}
export function stateRootForStoreFile(file: string, kind: string): string { return stateRootForStoreDirectory(dirname(resolve(file)), kind); }
export function stateRootForLockDirectory(directory: string): string {
  const absolute = resolve(directory), folder = process.platform === "win32" ? basename(absolute).toLowerCase() : basename(absolute);
  if (folder === "locks") return dirname(absolute);
  if (folder === ".locks") {
    const parent = dirname(absolute), name = process.platform === "win32" ? basename(parent).toLowerCase() : basename(parent);
    return name === "events" ? dirname(parent) : parent;
  }
  return absolute;
}
