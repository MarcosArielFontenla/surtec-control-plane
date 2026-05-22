# Paperclip Upstream

Repository: `https://github.com/paperclipai/paperclip.git`

Paperclip is the initial external orchestrator for Surtec Control Plane. It is not a rigid dependency and should be integrated only through the adapter layer.

## Update Model

- No clone is created during bootstrap.
- Use a fork, submodule, or snapshot only after an explicit decision.
- Updates require manual review and should not be applied automatically.

## Risks

- Upstream API or workflow changes may break adapter assumptions.
- Running directly from upstream `main` or `master` can introduce unreviewed behavior.
- Secrets and deployment configuration must remain outside this repository.

