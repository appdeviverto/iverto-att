# API sandbox (deferred)

Built on 2026-11-25 and taken out before release at the owner's request; kept here to bring back later. Design: [public-api.md §13](../../public-api.md).

- `sandbox.ts.txt` — `SandboxService` (provision + seed a SANDBOX tenant per org, reset, simulated terminal punch, close-day), `SandboxV1Controller` (`POST /v1/sandbox/punches`, `/sandbox/attendance/close-day`, `/sandbox/reset`), `SandboxModeGuard` (`X-Api-Env: test` on the org admin key/webhook screens).
- `sandbox.sql.txt` — `tenants.kind` / `parent_tenant_id` constraints and `sandbox_wipe()`, which refuses any tenant that is not a sandbox.

To restore: add `Tenant.kind` + `parentTenantId` (migration), the registry operations with a `sandboxOnly` flag (and keep them out of `methodsOf`, or every org's `attendance:read` would need POST), the kind ↔ key-environment check in `ApiKeyGuard`, the parent-policy derivation in `PolicyService.forTenant`, a sandbox check in `NotificationsService.notify`, `recompute(..., { closeNow })`, and the web test-mode switch.
