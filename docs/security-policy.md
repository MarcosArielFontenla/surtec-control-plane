# Security Policy

Security rules apply to this repository, agent execution, and generated automation.

## Secrets

- Do not commit real secrets.
- Use `.env.example` for placeholders only.
- Do not print full secrets in logs.
- Rotate any credential suspected of exposure.

## Sandbox

Allowed sandbox modes:

- `read-only` for review and analysis.
- `workspace-write` for controlled edits.

Disallowed sandbox modes:

- `danger-full-access`.

## Logs

Logs may contain sensitive context. Store only necessary execution output and avoid uploading secrets as artifacts.

## Legal And Privacy

Legal and privacy workflows may involve sensitive facts. Minimize data copied into prompts and mark human review requirements.

## Automation

Scripts default to dry-run or preview behavior. Real execution must be explicit and reviewable.

