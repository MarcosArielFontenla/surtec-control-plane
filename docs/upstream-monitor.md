# Upstream Monitor

The upstream monitor checks external repositories used as references by Surtec Control Plane.

## Monitored Upstreams

- Paperclip.
- Superpowers.
- agency-agents.
- claude-for-legal-argentina.

## Commands

```bash
./scripts/upstream/check-updates.sh
./scripts/upstream/generate-diff-report.sh
```

## Policy

The monitor reports status. It does not update automatically, clone automatically, merge automatically, or deploy.

## Reports

Reports are written under `reports/` and may be uploaded by GitHub Actions.

