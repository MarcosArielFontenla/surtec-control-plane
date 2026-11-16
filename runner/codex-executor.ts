import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { codexAppServerEnvironment } from "../lib/security/environment";
import type { AgentEventSink, AgentExecutor, AgentRunInput, AgentRunResult } from "./agent-executor";
import { CodexAppServerClient, type AppServerProcess } from "./codex-app-server";
import { runtimeContextProfile, runtimeContextSpawnArgs, type RuntimeContextProfileId } from "./runtime-context-profile";

export type SpawnAppServer = (profile: RuntimeContextProfileId) => AppServerProcess;

function defaultSpawnAppServer(profile: RuntimeContextProfileId): ChildProcessWithoutNullStreams {
  const executable = process.env.SURTEC_CODEX_BIN?.trim() || "codex";
  return spawn(executable, runtimeContextSpawnArgs(profile), {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    env: codexAppServerEnvironment(),
  });
}

export class CodexExecutor implements AgentExecutor {
  constructor(private readonly spawnAppServer: SpawnAppServer = defaultSpawnAppServer) {}

  run(input: AgentRunInput, events: AgentEventSink, signal: AbortSignal): Promise<AgentRunResult> {
    const profile = runtimeContextProfile(input.runtimeContextProfile);
    const client = new CodexAppServerClient(this.spawnAppServer(profile));
    return client.run(input, events, signal);
  }
}

export const codexExecutor: AgentExecutor = new CodexExecutor();
