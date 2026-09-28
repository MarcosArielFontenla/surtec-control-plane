# Local work sessions

Work sessions capture human context for one focused block of work. They are distinct from Codex tasks and project processes; they organize work but do not execute, stop, or cancel anything.

## Start, pause, resume, and complete

- In `Hoy`, choose a discovered project and enter the session objective. In project detail, the project is already selected.
- The server records the project's current local Git branch when available. Optional task and process IDs are checked against the same project before being linked.
- Add short notes as work changes. A resume card shows the objective, branch, notes, linked task lifecycle and latest event type, verification state, safe recorded PR link, and linked process status.
- Pausing requires an explicit next action. This is the end-of-day handoff; pausing does not stop a process or alter a Codex task.
- Resume from either `Hoy` or project detail. Only one session can be active across the local control plane; paused sessions remain available.
- Completion requires a result summary and a next action. Enter the literal `none` when no follow-up remains.

## Local persistence and elapsed time

The versioned document is stored at `state/sessions/work-sessions.json`, which is ignored by Git. `schemas/work-session.schema.json` validates each record and `schemas/work-sessions.schema.json` validates the containing document. Mutations use the shared state lock, schema validation, bounded input, a unique temporary file, and atomic replacement. Invalid or future-version state is not silently repaired or overwritten.

Elapsed focused time is based on manually started and paused intervals. The record stores accumulated completed intervals and the start of its current active interval, so state and the displayed timer survive a server restart. There is no keyboard, window, process-output, or app-activity monitoring. If an active session is left running while the user is away, its elapsed time continues until it is manually paused.

Sessions and notes are local plaintext and inherit host filesystem protections. Do not store credentials, tokens, private keys, or other secrets in objectives or notes. Completed records are retained; cleanup and retention controls are deferred. A linked process ID remains in the resume card after restart, but process status is unavailable because process history itself is currently in memory only.

## Resume evidence boundaries

The resume read model is deterministic. It never asks an LLM to infer historical facts and does not render task instructions, agent-result text, event payloads, raw process commands, absolute repository paths, or credentials. A pull request link appears only when a linked task already contains a validated GitHub pull-request URL. Missing task/process evidence stays visible as unavailable rather than being reconstructed.

Session mutation endpoints share the local API's loopback, same-origin, and in-memory session-token protections. Read the panel in either `Hoy` or project detail; `GET /api/today` includes the active, paused, and five most recent completed sessions.

Run `pnpm smoke:work-sessions:playwright` to exercise the Today and project-detail UI using fictional browser fixtures. The persistence/restart contract is covered separately by service/API tests using temporary local state; no model or provider calls are made.
