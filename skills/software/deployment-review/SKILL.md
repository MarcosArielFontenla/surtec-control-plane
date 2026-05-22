---
name: deployment-review
description: Use to review CI/CD, environment variables, migrations, rollback, logs, and observability before release.
---

# Skill: Deployment Review

## Objective

Assess deployment readiness and identify release blockers or rollback risks.

## When To Use

- Before deploying a feature or infrastructure change.
- Reviewing CI/CD, environment variables, migrations, monitoring, or rollback plans.

## Procedure

1. Identify release scope and affected services.
2. Review CI status, build steps, configuration, and environment variables.
3. Check migrations, backward compatibility, feature flags, and rollback path.
4. Review logs, metrics, alerts, and operational runbooks.
5. Mark human approval requirements.

## Output Format

- Release scope.
- Readiness checklist.
- Blockers.
- Rollback plan.
- Observability checks.
- Approval requirements.

## Limits

- Do not deploy.
- Do not modify production configuration.
- Do not expose secrets.

