# agency-agents To Codex Transform

This transform previews and builds selected Codex agent profiles from an optional `agency-agents` upstream snapshot.

The transform is intentionally selective. It must not import an entire external catalog without review.

## Commands

```bash
./transforms/agency-agents-to-codex/preview.sh
./transforms/agency-agents-to-codex/build.sh
```

`build.sh` is currently a guarded placeholder and requires `SURTEC_EXECUTE=1`.

