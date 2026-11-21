CREATE TYPE "ServiceContractStatus" AS ENUM ('ACTIVE', 'ENDED');
CREATE TABLE "service_contracts" (
  "id" TEXT NOT NULL, "buildingId" TEXT NOT NULL, "customerPersonId" TEXT NOT NULL,
  "managedById" TEXT NOT NULL, "title" TEXT NOT NULL, "amount" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "endsAt" TIMESTAMP(3),
  "status" "ServiceContractStatus" NOT NULL DEFAULT 'ACTIVE', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "service_contracts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "service_contracts_buildingId_status_idx" ON "service_contracts"("buildingId", "status");
ALTER TABLE "service_contracts" ADD CONSTRAINT "service_contracts_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_contracts" ADD CONSTRAINT "service_contracts_customerPersonId_fkey" FOREIGN KEY ("customerPersonId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_contracts" ADD CONSTRAINT "service_contracts_managedById_fkey" FOREIGN KEY ("managedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
