---
name: code-review
description: Use for review of code changes with focus on correctness, security, tests, maintainability, and regression risk.
---

# Skill: Code Review

## Objective

Review code changes and produce actionable findings ordered by severity.

## When To Use

- Reviewing a diff, branch, pull request, or patch.
- Checking correctness, security, maintainability, tests, and behavioral regressions.

## Procedure

1. Read the relevant diff and surrounding code.
2. Identify runtime bugs, broken contracts, security issues, missing tests, and maintainability risks.
3. Verify whether existing patterns were followed.
4. Prefer specific file and line references.
5. Keep summary secondary to findings.

## Output Format

- Findings ordered by severity.
- Open questions or assumptions.
- Test gaps.
- Brief change summary.

## Limits

- Do not rewrite unrelated code.
- Do not approve changes that have not been verified.
- Do not focus on style unless it affects behavior or maintainability.

