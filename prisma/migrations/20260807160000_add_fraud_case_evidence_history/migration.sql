CREATE TABLE "fraud_case_evidence" (
  "id" TEXT NOT NULL,
  "fraudCaseId" TEXT NOT NULL,
  "notes" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fraud_case_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fraud_case_evidence_fraudCaseId_createdAt_id_idx"
  ON "fraud_case_evidence"("fraudCaseId", "createdAt", "id");

ALTER TABLE "fraud_case_evidence"
  ADD CONSTRAINT "fraud_case_evidence_fraudCaseId_fkey"
  FOREIGN KEY ("fraudCaseId") REFERENCES "fraud_cases"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fraud_case_evidence"
  ADD CONSTRAINT "fraud_case_evidence_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "persons"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
