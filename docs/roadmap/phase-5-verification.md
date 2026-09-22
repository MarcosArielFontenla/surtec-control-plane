# Phase 5 — Integrations and extensibility verification

## Delivery summary

Phase 5 adds a versioned, read-only project integration snapshot without introducing a generic plugin system. The snapshot composes the existing local Git, GitHub, GitHub Actions, HTTP deployment-health, Railway, and optional tracing boundaries.

Only deployment observation receives a provider interface because it has two real implementations. Source control, CI, and tracing retain their concrete boundaries until another implementation justifies shared semantics.

## Delivered behavior

- `GET /api/projects/:id/integrations` returns `schema_version: 1`.
- Project and path resolution goes through `PolicyService`.
- Local Git status and GitHub remote counts are represented separately within source-control evidence.
- GitHub Actions status is represented as an explicit CI observation.
- HTTP health and Railway run through the same narrow `DeploymentProvider` contract.
- Providers execute independently and preserve deterministic registration order.
- A failed provider degrades its own observation without hiding successful providers.
- Aggregate reads use a 60-second in-memory cache; successful Git sync and branch operations invalidate the project snapshot.
- The existing `/github`, `/deploy`, and `/railway` endpoints remain compatible.
- Optional tracing records one aggregate span and one span per deployment provider.

## Contract and safety

`schemas/project-integrations.schema.json` rejects unsupported versions, additional properties, invalid provider identifiers, invalid health states, overlong errors, and malformed field types.

Before schema validation, the service:

- reconstructs provider output instead of spreading unknown fields;
- rejects provider identity mismatches;
- accepts only HTTP(S) URLs without embedded credentials;
- bounds provider status, timestamp, and error values;
- redacts credential-like error content;
- accepts only constrained trace identifiers;
- never returns or persists `RAILWAY_TOKEN`.

Provider configuration is explicit code. There is no package discovery, dynamic import, user-supplied module, or remote code execution path.

## Automated verification

Baseline before Phase 5:

```text
npm run test -- --run
63 test files passed
451 tests passed

npm run typecheck
passed

npm run schemas:check
Validated 10 JSON Schemas.
```

Final offline gate:

```text
npm run ci:check

schemas:check
Validated 11 JSON Schemas.

secrets:check
Secret scan passed (882 repository files checked).

evals:check
Coverage 36/36; expectations 42/42.

test
66 test files passed
465 tests passed

typecheck
passed

build
passed
```

Build detail:

```text
1910 modules transformed
dist/index.html                  0.42 kB | gzip 0.28 kB
dist/assets/index-DMGXPO77.css 30.44 kB | gzip 6.55 kB
dist/assets/index-j7oHpGIN.js 207.73 kB | gzip 62.15 kB
```

API smoke:

```text
npm run smoke:api
overview_status=200
today_status=200
dispatch_options_status=200
integrations_status=200
integration_schema_version=1
```

Focused tests cover:

- provider normalization and deterministic ordering;
- HTTP URL scheme and embedded-credential rejection before fetch;
- missing Railway credentials without credential disclosure;
- provider exception isolation and error redaction;
- unsafe provider response URL removal;
- provider identity mismatch handling;
- source-control and CI degradation;
- cache hit, expiry, invalidation, and rejected-read eviction;
- trace span and trace identifier behavior;
- runtime JSON Schema acceptance and rejection;
- API success, unknown project, and invalid identifier responses.

No browser smoke was run because Phase 5 changes no UI behavior. Automated tests and API smoke use fakes for external providers and make no network or paid model calls.

## Manual local validation

Start the local application:

```text
pnpm dev
```

Read a configured project:

```text
GET http://127.0.0.1:4317/api/projects/<project-id>/integrations
```

Confirm:

1. `schema_version` is `1` and `project_id` matches.
2. `source_control` contains local Git and GitHub observations independently.
3. `ci.provider` is `github-actions` for a GitHub registry entry.
4. `deployments` always preserves `http-health`, then `railway` order.
5. Providers without registry configuration report `unconfigured`.
6. Railway with registry identifiers but no environment credential reports configured but `unknown`, without exposing a token.
7. Repeating the request within 60 seconds returns the cached snapshot.
8. A successful branch or Git sync operation invalidates that project snapshot.

## Security impact

- No new mutation authority was added.
- Request input cannot choose filesystem paths, GitHub slugs, deployment URLs, or Railway identifiers.
- External output cannot add arbitrary response fields or executable behavior.
- Credential-like errors and URL credentials are removed before the API boundary.
- Provider failure does not become aggregate success and does not suppress peer evidence.
- Integration traces contain operational labels only, not provider output or credentials.

## Known risks and deferred work

- The HTTP probe trusts privileged registry configuration. It restricts scheme and embedded credentials but does not classify every internal network destination.
- GitHub CLI reads are synchronous and can briefly occupy the API process until their bounded timeout.
- The aggregate endpoint and legacy provider-specific endpoints have separate process-local caches and may temporarily disagree.
- Automated verification does not assert live GitHub, Railway, or deployment availability; live state depends on local tools, credentials, and network.
- Only deployment has a provider interface. Additional abstraction remains intentionally deferred.
- There is no integration-management UI, credential manager, dynamic provider installation, deployment action, rollback, merge, or push capability.
- Cache history is not persisted and resets with the API process.

## Local commits

- `64b6cd2` — `docs: define phase 5 integration plan`
- `52f6959` — `feat: add deployment integration providers`
- `58872e5` — `feat: expose project integration snapshots`
- `7eac364` — `test: use scanner-safe redaction fixtures`
- `549e95c` — `test: cover integrations in API smoke`

The verification documentation and roadmap status are committed separately at phase close.

## Recommended next phase

Do not begin Phase 6 without explicit authorization and a concrete collaboration requirement. If the control plane remains personal and single-user, prefer incremental maintenance: observe real integration usage, address provider-specific gaps, and add a second implementation before generalizing another domain.
