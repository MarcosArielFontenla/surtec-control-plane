import { homedir } from "node:os";
import { join } from "node:path";

// Expands a leading ~ to the user's home directory. OS-native separators.
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}
