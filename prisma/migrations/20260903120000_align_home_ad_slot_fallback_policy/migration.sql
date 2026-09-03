-- Frozen MVP Home advertising contract:
-- N1-N6 are VielHome Direct-only; S1-S3 may fall back to the existing
-- external-provider integration. Production provider credentials remain
-- intentionally unconfigured.
UPDATE "ad_slots"
SET
  "fillStrategy" = 'DIRECT_ONLY',
  "externalProvider" = 'NONE',
  "androidAdUnitId" = NULL,
  "iosAdUnitId" = NULL
WHERE "code" IN (
  'HOM-N-01',
  'HOM-N-02',
  'HOM-N-03',
  'HOM-N-04',
  'HOM-N-05',
  'HOM-N-06'
);

UPDATE "ad_slots"
SET
  "fillStrategy" = 'DIRECT_THEN_EXTERNAL',
  "externalProvider" = 'ADMOB',
  "androidAdUnitId" = NULL,
  "iosAdUnitId" = NULL
WHERE "code" IN ('HOM-S-01', 'HOM-S-02', 'HOM-S-03');
