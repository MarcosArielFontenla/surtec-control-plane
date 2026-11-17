import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createScaffoldOperationService } from "../lib/harness/scaffold-operation";
import { PolicyService } from "../lib/policy/service";
import { isSafeIdentifier } from "../lib/security/identifiers";
import { isPathWithin } from "../lib/security/paths";

type Terminal<T> = T & { isTTY?: boolean };
interface CliOptions {
  repoRoot?: string;
  environment?: NodeJS.ProcessEnv;
  stdin?: Terminal<Readable>;
  stdout?: Writable;
  stderr?: Terminal<Writable>;
}

const usage = [
  "Run from the Surtec Control Plane root.",
  "  pnpm exec tsx cli/surtec-scaffold.ts preview <project-id> personal@1",
  "  pnpm exec tsx cli/surtec-scaffold.ts apply <project-id> personal@1",
  "  pnpm exec tsx cli/surtec-scaffold.ts status <operation-id>",
  "  pnpm exec tsx cli/surtec-scaffold.ts rollback <operation-id>",
].join("\n") + "\n";

const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const successful = new Set(["available", "applied", "rolled-back", "no-op"]);

async function askApproval(
  action: "apply" | "rollback",
  plan: object,
  digest: string,
  input: Terminal<Readable>,
  output: Terminal<Writable>,
) {
  output.write(JSON.stringify({ action, plan }, null, 2) + "\n");
  const terminal = createInterface({ input, output, terminal: true });
  try {
    const expected = `${action} ${digest}`;
    const answer = await new Promise<string | null>((resolveAnswer) => {
      terminal.once("close", () => resolveAnswer(null));
      terminal.once("SIGINT", () => terminal.close());
      terminal.question(
        `Type exactly "${expected}" to approve this plan and confirm exclusive access until the operation ends. Any other response cancels.\n> `,
        resolveAnswer,
      );
    });
    return answer === expected ? { digest, exclusive: true } : null;
  } finally { terminal.close(); }
}

export async function runScaffoldCli(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const [command, id, selection] = args;
  if (args.length === 1 && command === "--help") {
    stdout.write(usage);
    return 0;
  }
  const projectCommand = command === "preview" || command === "apply";
  if (projectCommand
    ? args.length !== 3 || !isSafeIdentifier(id) || selection !== "personal@1"
    : (command !== "status" && command !== "rollback") || args.length !== 2 || !operationId.test(id)) {
    stderr.write(usage);
    return 2;
  }

  function emit<T extends { status: string }>(result: T) {
    stdout.write(JSON.stringify(result) + "\n");
    return successful.has(result.status) ? 0 : 1;
  }
  const mutates = command === "apply" || command === "rollback";
  if (mutates && (!stdin.isTTY || !stderr.isTTY)) {
    return emit({ status: "refused", reason: "interactive-terminal-required" } as const);
  }
  try {
    const repoRoot = resolve(options.repoRoot ?? process.cwd());
    const environment = options.environment ?? process.env;
    const defaultState = join(repoRoot, "state");
    const stateRoot = resolve(environment.SURTEC_STATE_DIR ?? defaultState);
    if (mutates && isPathWithin(repoRoot, stateRoot) && !isPathWithin(defaultState, stateRoot)) {
      return emit({ status: "refused", reason: "state-root-outside-ignored-state" } as const);
    }
    const service = createScaffoldOperationService(repoRoot, stateRoot, new PolicyService(repoRoot, { environment }));
    switch (command) {
      case "preview": return emit(service.preview({ projectId: id, selection }));
      case "status": return emit(service.status(id));
      case "apply": return emit(await service.apply({ projectId: id, selection }, (plan) =>
        askApproval("apply", plan, plan.apply_digest, stdin, stderr)));
      case "rollback": return emit(await service.rollback(id, (plan) =>
        askApproval("rollback", plan, plan.rollback_digest, stdin, stderr)));
    }
    return 2;
  } catch {
    return emit({ status: "unavailable", reason: "scaffold-command-failed" } as const);
  }
}

if (process.argv[1] && relative(fileURLToPath(import.meta.url), resolve(process.argv[1])) === "") {
  runScaffoldCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write("Scaffold command failed. Inspect the retained operation evidence.\n");
      process.exitCode = 1;
    },
  );
}
