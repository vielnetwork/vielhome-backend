CREATE TABLE "legal_acceptances" (
    "personId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "buildingId" TEXT,
    "buildingName" TEXT,
    "managerStartedAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("personId", "scope", "version"),
    CONSTRAINT "legal_acceptances_personId_fkey" FOREIGN KEY ("personId")
      REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
