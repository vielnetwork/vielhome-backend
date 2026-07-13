# VielHome Backend

REST API for VielHome — a mobile-first digital operating system for residential
buildings. NestJS + Prisma + PostgreSQL + Redis/BullMQ, built strictly
following the project's **AIHandoff V2** documentation (Product Philosophy,
Business Rules, Architecture, Engineering Constitution).

> This is a from-scratch rebuild of the backend, started fresh from the
> frozen AIHandoff V2 spec. It is not the old codebase.

## What's implemented so far

- **Cross-cutting infrastructure**: standard API response envelope, error
  taxonomy (`ValidationError`, `AuthorizationError`, `NotFound`, `Conflict`,
  `BusinessRuleViolation`, `Duplicate`, `RateLimit`, `UnexpectedError`),
  RequestId propagation, structured audit logging, domain-event pipeline.
- **Foundation / Auth**: OTP-based login (`request` → `verify`), JWT access +
  refresh tokens, device registration ("Remember Device").
- **Building**: resumable Building Setup Wizard with Draft/Auto-Save/Resume
  (Zero Data Loss), building creation with founding Owner/Manager membership
  and automatic skeleton unit generation, Unit management (create/list/update,
  unique-per-building enforcement), postal-code duplicate-building prevention
  with a Membership Request escape hatch, owner invites (console-logged, see
  "Known risk areas"). See `21_ADRs > ADR-021` in the project's AIHandoff docs
  for the full rationale.
- **Health**: `GET /health` (legacy, DB-only, kept for backward compatibility),
  `GET /health/live` (liveness — no dependency checks), `GET /health/ready`
  (readiness — Postgres + Redis checks in parallel). See `21_ADRs > ADR-064`.
- **Observability/CI (ADR-064)**: `helmet` security headers (CSP disabled —
  see `main.ts` comment — to keep Swagger UI at `/docs` working), structured
  JSON logging in production (`src/common/logging/json-logger.service.ts`,
  plain console output unchanged in dev), and a GitHub Actions CI pipeline
  (`.github/workflows/ci.yml`) running lint/test/e2e/build against real
  Postgres + Redis service containers on every push.

Everything else in `19_Current_Sprint` (Finance, Notifications, Gamification,
Marketplace, AI Assistant) is intentionally not started yet — build in that
order, following `21_ADRs` / `20_Frozen_Decisions` for anything that touches
an already-frozen decision.

## Why nothing has been run yet

This backend was scaffolded inside a sandboxed cloud workspace with **no
access to npm/package registries**, so `npm install` and `npm run start:dev`
have not been executed or tested here. Everything below is written to be
correct against NestJS 10 / Prisma 5 APIs, but you should treat the first
local run as the real first test pass — see "Known risk areas" at the bottom.

## Prerequisites

- Node.js 20+ and npm
- Docker (for local Postgres + Redis) — or point `DATABASE_URL`/`REDIS_HOST`
  at your own instances

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres + Redis
docker-compose up -d

# 3. Configure environment
cp .env.example .env
# edit .env if you changed any docker-compose ports/credentials

# 4. Create the database schema
npx prisma migrate dev --name init
# If you already had a database from before ADR-021 (postal code became
# required + unique, several Building/Unit columns were added), the plain
# migrate command above will fail or prompt for defaults because existing
# rows can't satisfy the new NOT NULL columns. This is pre-launch dev data
# — the simplest fix is to reset instead:
#   npx prisma migrate reset
# (drops the dev database, reapplies all migrations from scratch — do not
# run this against anything you care about keeping)

# 5. (optional) seed a dev user
npm run db:seed

# 6. Run the API in watch mode
npm run start:dev
```

The API listens on `http://localhost:3000/api/v1`.
Swagger docs: `http://localhost:3000/docs`.

## Trying the auth flow

```bash
# 1. Request an OTP (in dev, the code is printed to the server console —
#    no SMS gateway is wired up yet)
curl -X POST http://localhost:3000/api/v1/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone": "+989120000000"}'

# 2. Verify it (copy the code from the server log)
curl -X POST http://localhost:3000/api/v1/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"phone": "+989120000000", "code": "12345", "deviceToken": "dev-device-1", "platform": "web"}'

# -> returns { data: { accessToken, refreshToken, personId, isNewPerson } }

# 3. Start the Building Setup Wizard (use accessToken from step 2)
curl -X POST http://localhost:3000/api/v1/buildings/setup/draft \
  -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" \
  -d '{"step": "role_selection", "payload": {"role": "OWNER"}}'

curl -X POST http://localhost:3000/api/v1/buildings/setup/draft \
  -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" \
  -d '{"step": "review", "payload": {"name": "Vista Tower", "totalUnits": 12, "buildingType": "RESIDENTIAL", "country": "IR", "city": "Tehran", "district": "Saadat Abad", "mainStreet": "Sarv", "plateNumber": "12", "postalCode": "1998877665"}}'

curl -X POST http://localhost:3000/api/v1/buildings/setup/submit \
  -H "Authorization: Bearer <accessToken>"
```

## Project structure

Follows `11_Backend_Architecture` (Domain-Driven Design) and
`09_Engineering_Constitution` (Feature-First, layered):

```
src/
  common/           cross-cutting: prisma, audit, errors, filters,
                    interceptors, middleware, guards, decorators, events
  config/           typed configuration loader
  modules/
    foundation/
      auth/         controller / application / domain / infrastructure / events
      identity/     (Person — currently just Prisma model + Auth usage)
    building/       controller / application / domain / infrastructure / events
    health/
prisma/
  schema.prisma     Foundation + Building domains, Zero Data Loss draft store,
                     append-only AuditLog
```

Each feature module keeps the same shape: **controllers are thin**, business
rules live in `domain/`, orchestration in `application/`, persistence in
`infrastructure/`. Never add business logic to a controller or a repository
— see `09_Engineering_Constitution.md` in the project's AIHandoff docs.

## Known risk areas (things to double-check on first real run)

- **`package-lock.json` does not exist yet — CI will fail until this is
  fixed**: this sandbox has never had npm registry access (unchanged since
  ADR-022/Sprint 3.9), so `npm install` has never actually been run here,
  and no lockfile has ever been generated or committed. The new
  `.github/workflows/ci.yml` (ADR-064) uses `npm ci`, which *requires*
  `package-lock.json` to exist and fails without one. Run `npm install`
  locally once (your local runs have already been succeeding, so this may
  already be effectively done — just confirm the resulting
  `package-lock.json` is committed to git) before pushing to a remote that
  runs this workflow. Tracked as a release blocker alongside ADR-063's
  migration-baseline step — see `25_API_v1_Database_Freeze_Manifest_v1.0`.
- **Prisma client types**: `npx prisma generate` must run (via `postinstall`
  triggered by `npm install`, or manually) before `tsc`/`ts-node` will
  resolve `@prisma/client` types like `MembershipRole`, `UnitType`,
  `OtpPurpose`.
- **`class-validator` phone validation**: `@IsPhoneNumber(undefined)` accepts
  any region — confirm this is permissive enough for your target markets, or
  pin it to specific country codes.
- **JWT/refresh token durations**: `parseDurationMs` in `auth.service.ts` is a
  minimal hand-rolled parser (`15m`, `30d`, etc.) — swap for a library like
  `ms` if you need broader format support.
- **SMS gateway**: OTP codes are only logged to the console right now
  (`console.log` in `AuthService.requestOtp`). Wire a real provider into
  `infrastructure/` before this touches production.
- **Throttling**: `ThrottlerModule` is registered but no guard is applied
  globally yet — add `APP_GUARD: ThrottlerGuard` once you're ready to
  enforce rate limits (important for the OTP endpoints specifically, per
  `05_Business_Rules > Security Rules`).
- **Per-building authorization — RESOLVED**: `MembershipGuard`
  (`src/common/guards/membership.guard.ts`) is now applied at the method
  level to every `/buildings/:id/...` route that should be member-only:
  `GET :id`, `GET :id/units`, `GET :id/units/:unitId`, `POST :id/units`,
  `PATCH :id/units/:unitId`, `POST :id/units/:unitId/invite-owner`,
  `GET :id/membership-requests`, `PATCH :id/membership-requests/:requestId`.
  It checks `Membership.personId + buildingId (isCurrent: true)` and throws
  `AuthorizationError` (403) otherwise, satisfying `05_Business_Rules >
  Security Rules`. `POST :id/membership-requests` deliberately has NO guard
  — a non-member requesting to join is the entire point of that endpoint.
  **RESOLVED (ADR-064)**: `resolveMembershipRequest` previously only checked
  *membership*, not *role* — any member (not just OWNER/MANAGER) could
  approve/reject a join request. Now gated `RolesGuard` + `@Roles('OWNER',
  'MANAGER')`, the same pattern `changeManager` already used.
- **Membership Request has no review UI**: `POST/GET /buildings/:id/
  membership-requests` and `PATCH /buildings/:id/membership-requests/
  :requestId` (approve/reject) exist, but nothing in the mobile app surfaces
  pending requests to an existing manager/owner yet — resolve them via the
  API directly (or Prisma Studio) until that screen ships (see ADR-021).
- **Owner invite auto-linking — RESOLVED**: `AuthService.verifyOtp` now
  calls `BuildingService.linkOwnerAccountByPhone` on every OTP verify
  (login and signup), which finds any skeleton units whose `ownerPhone`
  matches the verifying person's phone and don't already have a current
  Ownership row, and atomically creates the Ownership + OWNER Membership
  for them (`BuildingRepository.findUnlinkedOwnerUnitsByPhone` /
  `linkOwnerToUnit`). The verify response now also returns `hasBuildings`;
  the mobile app routes on that instead of `isNewPerson`, so a person who
  was invited by phone lands straight on their dashboard instead of the
  Building Setup wizard. The SMS delivery itself is still console-logged
  only (same gap as OTP codes) — the person has to already know their
  invite exists (told out-of-band) since no real SMS goes out yet.

## Next steps (per `19_Current_Sprint`)

1. Finish Building Unit Management (bulk unit creation / skeleton units per
   `06_User_Flows > Building Setup Assistant`).
2. Owner/Tenant Registration + Invitation flow (`Membership Flow`).
3. Finance MVP (`12_Finance_Architecture`) — immutable ledger, charges,
   payments, funds.
4. Notification Engine (`13_Notification_Architecture`).
