# Factory Local F3 — Engineer context and candidate bytes

Status is proposed. Read-only diagnosis and isolated Git qualification are complete. This design applies to a new private pilot capsule after review.

## Engineer evidence

The stopped Engineer attempt had a 100,000-token ceiling and used 26,928 ms of active runtime. The runtime interrupted the turn on the fourth cumulative sample. The charge retains 118,491 observed tokens and incomplete final usage. The worktree was clean at the original commit. There is no candidate, captured verification, Reviewer, or QA result. The pilot observed lower bound is 416,174 tokens and the combined final total remains unknown.

The admitted context manifest contained 16 sources, 26,476 bytes and 66 lines. The assembled role context measured 27,639 bytes and 84 lines. The first response already processed 21,325 input tokens. Native exact-turn usage samples show the following sequence. Cached input is a subset of input, and reasoning is a subset of output.

| Response | Input | Cached input | Output | Reasoning | Gross response total | Cumulative gross |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 21,325 | 0 | 96 | 0 | 21,421 | 21,421 |
| 2 | 30,955 | 21,120 | 149 | 83 | 31,104 | 52,525 |
| 3 | 32,750 | 30,720 | 118 | 26 | 32,868 | 85,393 |
| 4 | 32,891 | 32,640 | 207 | 57 | 33,098 | 118,491 |
| Total | 117,921 | 84,480 | 570 | 166 | 118,491 | 118,491 |

Two broad tool-catalogue lookups returned 40,109 and 7,563 UTF-8 bytes of tool metadata. The first returned 12 tool names with descriptions. The second selected 19 normalized identifiers. The next input samples grew by 9,630 and 1,795 tokens, respectively. The only concrete shell call was a targeted search with an empty result body. This chronology identifies the main avoidable input expansion. It does not establish tokenizer-exact source allocation, an equivalent result with the proposed adjustment, or provider-final billing. Retain the G2 result, charge, task, events, and native artifact by hash in place.

## Minimal context adjustment

Append the following instruction to the Engineer responsibility in the new private role registry. Use the existing attributed role source and preview bindings. Keep the existing source inventory and exact admitted instructions.

> For local shell inspection, use tools.exec_command directly when it is available. If a tool is missing, look up only its exact name and return names only, with at most five matches and no descriptions. Limit inspection responses to 1500 tokens per call where the tool supports it. Read every required source completely in bounded slices.

This guidance targets the two observed discovery calls. It preserves required reads, sandbox, tools, permissions, exact verification, existing prompt limits and cumulative accounting. It is guidance, so an offline check can verify rendered text, source isolation and bounds. It cannot prove token savings or enforce tool selection. A deterministic catalogue restriction requires separate design if the available capability surface can support it.

## Exact-byte worktree adjustment

The trusted verifier compares the raw physical bytes with Git blobs. The actual stopped worktree had 241 LF blobs materialized as CRLF despite clean status. The exact-byte fixture used the installed Git 2.47.1.windows.2 with a synthetic local `core.autocrlf=true` and isolated config.

| Fixture | Observed result |
| --- | --- |
| Existing Git defaults | Checkout turned LF into CRLF while Git reported a clean worktree. Staging turned an intentional CRLF edit into LF. |
| Checkout override only | Physical checkout matched the baseline blob. Staging still normalized the edit. |
| Scoped override for checkout and staging | Physical LF, intentional CRLF, new LF and binary files matched both staged and committed blobs. The source config, source HEAD and source files were unchanged. |
| Downstream inspection of the sealed fixture | Default `hash-object --stdin-paths` differed for the CRLF edit. The same scoped override matched all sealed blobs. |
| Explicit `text eol=crlf` attribute | The override alone still allowed checkout and staging conversion. The byte contract must fail closed when effective conversion is present. |

In the new private capsule, use the command-local Git option `-c core.autocrlf=false` in the managed `worktree add` and `add -A` calls, plus the downstream candidate inspection Git invocation. Keep the production implementation, the pilot repository, the original capsule, and existing worktrees separate from this private delta. Preserve the existing hooks, branch, path, ownership, lease, allowlist, and candidate guards. Both create branches must apply the checkout flag, including the exact-base correction branch, even though correction stays disabled in this pilot.

Use the pinned base and authorized paths for a read-only effective-attribute check before provisioning a new candidate. The inspected Gear baseline and the six authorized new paths have no effective Git attributes. For this pilot, refuse active content-conversion attributes and unknown scope coverage. The fixture proves that explicit attributes can override the command option. Compare raw bytes to the base blobs before a model turn and to the index after staging before committing. Retain bounded byte reads, exact path containment and current ownership checks. A mismatched reused worktree fails the preflight; the operator keeps its bytes for review. Retain the trusted verifier and its raw-byte seal.

The affected runtime locations are [managed Git checkout and staging](../../runner/worktree.ts), [owned writer execution](../../runner/run-task.ts) and [candidate inspection before review](../../runner/workflow-stage.ts). The private capsule delta uses the existing context profile, registry format, candidate shape and verifier command.

## Qualification before further execution

1. Pin a new private capsule and qualify the Engineer role text and worktree delta only. Compare the exact role registry change, context source hashes, role ceilings, verifier, scope, testing policy and safety settings.
2. Run the synthetic byte matrix through the real managed worktree functions and downstream inspection. Include explicit-attribute rejection, exact base, reuse without rewriting, scope rejection, and CRLF and binary changes. Use a fake executor to prove an unsafe worktree stops before a model effect and a staged byte mismatch stops before commit.
3. Run the focused worktree and owned-runner tests, then typecheck. Keep the historical result and charged usage unchanged. The current interrupted workflow remains blocked. Any later real execution requires its own reviewed accounting, current prerequisite checks, and explicit owner authority.

Only the four isolated Git cases ran for this diagnosis. No product code, verifier, real worktree, or historical state was changed. No model was invoked.
