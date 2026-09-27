# Repository settings checkpoint

## Tracked repository configuration

Default branch: `master`

The workflow consistency check compares this documented default branch with the `push.branches` filter in `.github/workflows/ci.yml`. Update both together when the default branch changes. The check is local and deterministic; it does not query or modify GitHub settings.

## Manual GitHub checklist

The project prompt records that a previously reviewed GitHub snapshot showed public visibility and a stale Paperclip-adapter description. That observation has not been independently re-verified as part of Phase A. Do not treat any item below as complete until Marcos confirms it in GitHub.

- [ ] Confirm whether this personal control plane repository must be private.
- [ ] Update the GitHub description to describe the current Codex-native Surtec Control Plane.
- [ ] After CI has successfully run from `master`, enable appropriate branch protection for `master`.
- [ ] Require the CI `verify` check before merge.
- [ ] Prefer feature branches and pull requests over direct pushes to `master`.

No GitHub visibility, metadata, branch protection, or other remote settings are changed by repository scripts.
