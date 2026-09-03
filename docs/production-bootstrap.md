# Production database bootstrap

DO NOT run the development/demo seed in production.

Provision an empty PostgreSQL database and set DATABASE_URL securely in the
operator environment. Confirm the destination before executing any command.

```sh
npx prisma migrate deploy
npm run db:seed:reference
# Supply the real operator-controlled identity; no default phone or credentials.
npm run bootstrap:backoffice -- --phone "$BOOTSTRAP_ADMIN_PHONE" --full-name "$BOOTSTRAP_ADMIN_FULL_NAME"
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
