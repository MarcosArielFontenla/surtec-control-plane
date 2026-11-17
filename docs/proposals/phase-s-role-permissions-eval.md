# Phase S · Check role permissions against project and global ceilings

## Scope

Add `org.role.permission-ceilings` to the mandatory S.1 offline gate. The [production policy service](../../lib/policy/service.ts) intersects the project sandbox and verification configuration with the registered agent sandbox before selecting a logical role. The [logical role selector](../../lib/policy/roles.ts) additionally checks role capabilities and the registered agent's allowed task kinds. The [role registry contract](../../schemas/agent-role-registry.schema.json) limits declared sandboxes and tools to the supported set. For this slice, the global ceilings are the registered agent policy and this code-owned contract.

Use `PolicyService.authorizeRole` directly on a disposable registry and contained project. An allowed role can request write or verification only where the other ceilings also permit it. The EVAL observes policy decisions before dispatch. It uses the same copied policy inputs and owned-root cleanup as the [permitted-role EVAL](../../scripts/organizational-execution-role.test.ts). Existing [role policy tests](../../lib/policy/roles.test.ts) and [dispatch policy tests](../../lib/policy/service.test.ts) remain separate regressions.

## Cases

Use a synthetic project that allows `backend-engineer` and a copied `software-engineer` role. The base fixture allows workspace writes and supplies one inert verification command in project configuration. Each variant starts from the same base. A negative case changes only the relevant policy input or requested task kind. Validate the relevant fixture prerequisites before asserting the denial so a missing project or unrelated registry error cannot satisfy it.

| Variant | Request or change | Expected policy result |
| --- | --- | --- |
| Allowed write and verification | Request `implementation` with `workspace-write` and self-verification under the base fixture | Return the exact requested role and agent with `inspect`, `edit-authorized-scope` and `verify-configured`. |
| Read-only tools | Request `analysis` with `read-only` and no self-verification under the base fixture | Return only `inspect` even though the role declares write tools. |
| Project sandbox ceiling | Set only the project sandbox to `read-only` and request the original write mode | `PolicyError` with code `denied` and the project write-ceiling reason. |
| Project verification ceiling | Remove only the project verification command and request the original write-and-verify mode | `PolicyError` with code `denied` and the missing-verification reason. |
| Global agent sandbox ceiling | Set only the copied agent's default sandbox to `read-only` and request the original write mode | `PolicyError` with code `denied` and the registered agent write-ceiling reason. |
| Global agent task-kind ceiling | Request `frontend-implementation` with `workspace-write`, a task kind listed for the role and absent from the copied backend agent policy | `PolicyError` with code `denied` and the registered-agent task-kind reason. |
| Global role contract | Set the copied role's declared sandbox ceiling to `full-access` and request the otherwise allowed policy selection | `PolicyError` with code `configuration` for an unsupported role registry. |

Confirm that authorization preserves the prepared registry bytes and creates no task or worktree state. The verification command is fixture data. Keep the runtime, agents, roles, project registries, schemas, budgets and approvals outside the implementation scope. The EVAL covers permission ceilings at policy resolution. It leaves runner revalidation to `org.execution.permitted-role`.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T010 | Share only disposable policy fixture setup and identity-checked cleanup, preserve the four permitted-role cases, and add the seven ceiling cases. | `scripts/testing/role-policy-fixture.ts`, `scripts/organizational-execution-role.test.ts`, `scripts/organizational-role-permissions.test.ts` |
| T011 | Include the new file in the single-worker organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval.

1. `pnpm exec vitest run scripts/organizational-role-permissions.test.ts scripts/organizational-execution-role.test.ts` must pass the seven new cases and all four existing cases.
2. `pnpm exec vitest run lib/policy/service.test.ts lib/policy/roles.test.ts` must pass the existing policy regressions.
3. `pnpm evals:check` must pass v1, v2 and all five organizational EVALs.
4. `pnpm typecheck` must exit 0.

## T010–T011 acceptance on 2026-11-16

**The [`org.role.permission-ceilings` increment](../../scripts/organizational-role-permissions.test.ts) is complete.** T010 shared the disposable policy fixture, preserved the four permitted-role cases and verified the seven ceiling cases through `PolicyService`. The tests confirmed the expected tool grants and denials, preserved the prepared registry bytes, and verified that policy resolution created no task or worktree state. T011 added the new file to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Organizational role focused tests | Exit 0. 11 passed in 2 files. |
| Policy service and logical role regressions | Exit 0. 22 passed in 2 files. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 23 organizational tests passed. |
| `pnpm typecheck` | Exit 0. |

The changes remained local. Phase S continues with the [proposed required approval EVAL](phase-s-required-approval-eval.md).
