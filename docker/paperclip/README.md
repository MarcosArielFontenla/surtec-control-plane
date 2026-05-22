# Paperclip Local Placeholder

This folder contains a placeholder Docker Compose setup for a future Paperclip integration.

Paperclip is the initial orchestrator candidate, but Surtec Control Plane must integrate through the adapter layer instead of depending directly on Paperclip internals.

## Rules

- Prefer a reviewed fork or pinned release for real use.
- Do not deploy directly from upstream `main` or `master`.
- Do not place real secrets in `.env`.
- Keep integration traffic flowing through `adapters/paperclip-codex-adapter/`.

## Usage

Copy `.env.example` to `.env` only for local experiments, then replace placeholder values. The current compose file is not production-ready and should not be run as a deployment.

