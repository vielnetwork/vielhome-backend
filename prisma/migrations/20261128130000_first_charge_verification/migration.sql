-- CreateTable
CREATE TABLE "charge_verification_polls" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "requiredApprovals" INTEGER NOT NULL,
    "unitIds" TEXT[],
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "charge_verification_polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_verification_ballots" (
    "pollId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_verification_ballots_pkey" PRIMARY KEY ("pollId","unitId")
);

-- CreateIndex
CREATE UNIQUE INDEX "charge_verification_polls_membershipId_key" ON "charge_verification_polls"("membershipId");

-- CreateIndex
CREATE INDEX "charge_verification_polls_draftId_idx" ON "charge_verification_polls"("draftId");

-- AddForeignKey
ALTER TABLE "charge_verification_polls" ADD CONSTRAINT "charge_verification_polls_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_verification_polls" ADD CONSTRAINT "charge_verification_polls_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "charge_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_verification_ballots" ADD CONSTRAINT "charge_verification_ballots_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "charge_verification_polls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_verification_ballots" ADD CONSTRAINT "charge_verification_ballots_voterId_fkey" FOREIGN KEY ("voterId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
