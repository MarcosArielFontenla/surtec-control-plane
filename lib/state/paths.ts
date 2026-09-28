import { join } from "node:path";

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
