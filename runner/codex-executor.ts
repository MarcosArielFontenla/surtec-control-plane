import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEventSink, AgentExecutor, AgentRunInput, AgentRunResult } from "./agent-executor";
import { CodexAppServerClient, type AppServerProcess } from "./codex-app-server";

export type SpawnAppServer = () => AppServerProcess;

const ENV_ALLOWLIST = new Set([
  "APPDATA", "CODEX_HOME", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LOCALAPPDATA", "NO_PROXY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_PROJECT", "PATH", "PATHEXT",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SSL_CERT_DIR", "SSL_CERT_FILE", "SYSTEMROOT",
  "TEMP", "TMP", "USERPROFILE", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
]);

export function appServerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => ENV_ALLOWLIST.has(key.toUpperCase())),
  );
}

function defaultSpawnAppServer(): ChildProcessWithoutNullStreams {
  const executable = process.env.SURTEC_CODEX_BIN?.trim() || "codex";
  return spawn(executable, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    env: appServerEnvironment(),
  });
}

export class CodexExecutor implements AgentExecutor {
  constructor(private readonly spawnAppServer: SpawnAppServer = defaultSpawnAppServer) {}

  run(input: AgentRunInput, events: AgentEventSink, signal: AbortSignal): Promise<AgentRunResult> {
    const client = new CodexAppServerClient(this.spawnAppServer());
    return client.run(input, events, signal);
  }
}

export const codexExecutor: AgentExecutor = new CodexExecutor();
