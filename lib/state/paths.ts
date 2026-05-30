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

export function notesDir(base: string = stateDir()): string {
  return join(base, "notes");
}
