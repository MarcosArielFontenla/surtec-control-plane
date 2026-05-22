---
name: secrets-review
description: Use to detect and prevent exposure of secrets in files, logs, config, tokens, keys, and permissions.
---

# Skill: Secrets Review

## Objective

Find possible secret exposure and recommend safe remediation.

## When To Use

- Reviewing `.env`, logs, CI configuration, deployment files, scripts, or repository history.
- Checking tokens, keys, credentials, connection strings, and privileged permissions.

## Procedure

1. Identify files and outputs that may contain secrets.
2. Distinguish placeholders from real credentials.
3. Check whether sensitive values are committed, logged, echoed, or uploaded as artifacts.
4. Recommend rotation, removal, ignore rules, and safer configuration patterns.
5. Mark any remediation needing owner approval.

## Output Format

- Scope reviewed.
- Findings.
- Exposed or suspicious values.
- Recommended remediation.
- Rotation needs.
- Follow-up checks.

## Limits

- Do not print full secret values.
- Do not rotate or delete secrets without explicit approval.

