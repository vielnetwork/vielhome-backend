ALTER TABLE "fraud_case_evidence"
  ALTER COLUMN "authorId" DROP NOT NULL;

-- Preserve evidence recorded before the append-only table existed. The old
-- scalar stored neither an author nor its own timestamp, so attribution stays
-- explicitly unknown and `updatedAt` is the closest durable timestamp.
INSERT INTO "fraud_case_evidence" ("id", "fraudCaseId", "notes", "authorId", "createdAt")
SELECT 'legacy_' || md5("id"), "id", "evidenceNotes", NULL, "updatedAt"
FROM "fraud_cases"
WHERE "evidenceNotes" IS NOT NULL;
