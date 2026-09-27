import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { codexAppServerEnvironment } from "../lib/security/environment";
import type { AgentEventSink, AgentExecutor, AgentRunInput, AgentRunResult } from "./agent-executor";
import { CodexAppServerClient, type AppServerProcess } from "./codex-app-server";

export type SpawnAppServer = () => AppServerProcess;

function defaultSpawnAppServer(): ChildProcessWithoutNullStreams {
  const executable = process.env.SURTEC_CODEX_BIN?.trim() || "codex";
  return spawn(executable, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    env: codexAppServerEnvironment(),
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
