# Phase 5 — Integrations and extensibility plan

## Objective

Expose one typed, read-only project integration snapshot across the existing local Git, GitHub, CI, HTTP deployment-health, Railway, and tracing boundaries. Introduce an interface only where two real deployment implementations already exist.

Phase 5 remains part of the local modular monolith. It does not create a plugin framework, dynamically load code, add provider credentials to persisted state, or authorize new mutations.

## Entry decision

The phase is justified by current implementations:

- local Git status and GitHub remote metadata already provide complementary source-control evidence;
- GitHub Actions status already provides a concrete CI signal;
- HTTP health checks and Railway deployment reads are two real implementations of deployment observation;
- the optional tracer is an established observability boundary.

Only deployment observation receives a provider interface. Source control and CI keep explicit concrete adapters until another real implementation requires a shared contract.

## In scope

### 1. Stable integration read model

- Add a versioned `ProjectIntegrationsSnapshot` contract.
- Normalize provider availability and health without erasing provider-specific status.
- Include observation timestamps and an optional trace identifier.
- Keep errors bounded, redacted, and safe for API responses.

### 2. Narrow deployment provider interface

- Define a `DeploymentProvider` read contract.
- Adapt the existing registry-backed HTTP health check.
- Adapt the existing registry-backed Railway deployment reader.
- Run providers independently so one degraded provider does not hide the others.
- Keep provider registration explicit in code and deterministic in output.

### 3. Project integration service

- Resolve projects through `PolicyService` before touching paths, repository identifiers, or provider configuration.
- Read contained local Git status, GitHub counts, GitHub Actions state, and configured deployment providers.
- Preserve current source-control, CI, deployment, and Railway endpoints.
- Add `GET /api/projects/:id/integrations` as the consolidated read-only surface.
- Add a bounded TTL cache so repeated dashboard or operator reads do not multiply external calls.

### 4. Observability and verification

- Instrument the aggregate read and each deployment observation through the optional `Tracer` interface.
- Unit-test normalization, failure isolation, deterministic provider order, redaction, URL safety, caching, and tracing.
- Add API tests for configured, unknown, and invalid project identifiers.
- Update architecture, threat model, and local runbook documentation.

## Security invariants

- Integration reads never execute registry-provided shell commands.
- Project identifiers and local paths are resolved by the canonical policy service.
- GitHub CLI calls retain fixed argument vectors and purpose-specific environments.
- HTTP deployment probes accept only registry-backed `http` or `https` URLs without embedded credentials.
- Railway credentials remain environment-only and never appear in snapshots, errors, traces, or persisted state.
- Provider responses and exceptions are untrusted, redacted, bounded, and failure-isolated.
- The consolidated endpoint is read-only and does not weaken mutation-session protection.

## Explicit non-goals

- Dynamic plugins, package discovery, user-supplied modules, or remote code loading.
- A generic interface shared by unrelated integration domains.
- New source-control, CI, deployment, or observability vendors without a real implementation.
- Push, pull request creation, merge, deployment, rollback, or any other external mutation.
- Credential storage or management.
- UI redesign; existing project-card controls remain unchanged.

## Delivery slices

1. **Plan and contracts** — record the abstraction threshold and add the versioned read model.
2. **Deployment providers** — adapt HTTP health and Railway behind one narrow interface with security tests.
3. **Integration service and API** — compose concrete source-control/CI reads, deployment providers, cache, and tracing.
4. **Verification and documentation** — run all offline gates, API smoke, document security impact, residual risks, and extension rules.

## Completion criteria

- Both existing deployment implementations conform to the same tested provider contract.
- The aggregate endpoint returns a schema-versioned, deterministic, credential-free snapshot.
- Missing tools, credentials, provider failures, and malformed provider output degrade safely instead of failing the whole snapshot.
- Existing endpoints and UI behavior remain compatible.
- Automated tests make no network calls and no paid model calls.
- Schema validation, secret scan, evaluation gate, tests, typecheck, build, and API smoke pass.
