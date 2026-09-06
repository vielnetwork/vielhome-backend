# Production database bootstrap

DO NOT run the development/demo seed in production.

Provision an empty PostgreSQL database and set DATABASE_URL securely in the
operator environment. Confirm the destination before executing any command.

```sh
npx prisma migrate deploy
npm run db:seed:reference
# Supply the real operator-controlled identity; no default phone or credentials.
npm run bootstrap:backoffice -- --confirm-production
```

Reference bootstrap runs the unchanged authoritative RBAC seed, unchanged
Advertising slot seed, and independent achievement seed. It can be rerun after
a failure: rows are matched by their existing keys and achievement IDs remain
stable. Run serially, not concurrently. `npm run db:seed` and direct
`prisma/seed.ts` execution mean the same safe reference-only operation.
No Prisma migration configuration is changed; migrate deploy does not seed.

Before the explicit admin step, verify Persons, PlatformStaff and StaffRole
tables are empty on the newly provisioned database. Verify 8 roles, 46
permissions, 98 active grants, 5 achievement codes and 11 advertising slots.
N1–N6 are DIRECT_ONLY/NONE; S1–S3 DIRECT_THEN_EXTERNAL/ADMOB;
HOM-I-01/PAY-I-01 are FULL_SCREEN and DIRECT_ONLY/NONE.

Before the admin step, this query must return three zeroes:

```sql
SELECT (SELECT count(*) FROM persons) AS persons,
       (SELECT count(*) FROM platform_staff) AS staff,
       (SELECT count(*) FROM staff_roles) AS staff_roles;
```

These counts describe the current catalog, not a mechanism for deleting
unexpected rows. Stop and investigate if identities already exist on a database
that was expected to be empty. Reference bootstrap never removes existing users.

The existing administrator bootstrap creates the operationally supplied Person,
legacy PLATFORM_ADMIN rank and Technical Admin RBAC assignment, with
SYSTEM_BOOTSTRAP audit entries. It creates no password/token. Normal OTP login
is used. Once an active Technical Admin exists, repeating the command is a
no-op. It is not an automatic part of reference bootstrap and does not grant
the Super Admin role. See ADR-118 for its existing policy.

Production refuses to proceed without the literal `--confirm-production` CLI
flag. Supply `BOOTSTRAP_ADMIN_PHONE` and `BOOTSTRAP_ADMIN_FULL_NAME` through the
safest runtime input mechanism available; do not place identity values directly
in persistent Render Job command metadata. CLI `--phone`/`--full-name` remain
supported and take precedence over environment variables, but expose their
values to command history and job metadata.

If the supplied phone already belongs to a normal `Person`, the bootstrap
refuses without `--allow-existing-person`. Add that flag only after independently
confirming the existing account is the intended operator. Existing profile data,
including `fullName`, is never overwritten.

The script's stdout contains only status and opaque IDs. Audit metadata contains
opaque identity/staff/role IDs, role name, creation status, and the
`SYSTEM_BOOTSTRAP` source marker; it does not contain phone or full name.

For disposable local development only:

```sh
npx prisma migrate deploy
npm run db:seed:reference
NODE_ENV=development npm run db:seed:dev
```

The explicit dev seed creates Dev Tester and BackOffice Reviewer plus their
legacy staff ranks. It refuses execution unless NODE_ENV is development.
This guard does not identify the destination database: operators must never
point the dev command at a production DATABASE_URL.
