# TaskEnvelope Contract

`TaskEnvelope` is the neutral task format for Surtec Control Plane.

## Purpose

Any orchestrator can produce a `TaskEnvelope`: Paperclip, GitHub Issues, Linear, Jira, a CLI, or a future Surtec dashboard.

## Required Fields

- `id`: stable task identifier.
- `source`: origin system.
- `project`: project id from `registry/projects.yml`.
- `task_type`: type of work.
- `agent`: agent id from `registry/agents.yml`.
- `title`: short task title.
- `instructions`: detailed task instructions.
- `repo_path`: local project repository path.
- `branch`: intended task branch.
- `sandbox`: `read-only` or `workspace-write`.
- `expected_outputs`: required delivery sections.
- `requires_human_approval`: review gate marker.
- `metadata`: source-specific data.

## Execution

The Codex runner reads the envelope, builds a prompt, and either prints a dry-run command or executes Codex CLI when `SURTEC_EXECUTE=1`.

## Validation

The JSON Schema lives at:

```text
schemas/task-envelope.schema.json
```

