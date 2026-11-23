ALTER TABLE "memberships"
  ADD COLUMN "canIssueCharges" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "canManageFunds" BOOLEAN NOT NULL DEFAULT false;
