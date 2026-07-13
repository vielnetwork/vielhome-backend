-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'REGISTER', 'VERIFY_PHONE');

-- CreateEnum
CREATE TYPE "BuildingStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'MERGED', 'PENDING_INFORMATION');

-- CreateEnum
CREATE TYPE "BuildingType" AS ENUM ('RESIDENTIAL', 'COMMERCIAL', 'MIXED');

-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('RESIDENTIAL', 'COMMERCIAL', 'PARKING', 'STORAGE');

-- CreateEnum
CREATE TYPE "UnitOccupancyStatus" AS ENUM ('VACANT', 'OWNER_OCCUPIED', 'TENANT_OCCUPIED');

-- CreateEnum
CREATE TYPE "TenancyStatus" AS ENUM ('ACTIVE', 'NOTICE_GIVEN', 'ENDED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'TENANT', 'MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT');

-- CreateEnum
CREATE TYPE "ManagerLifecycleState" AS ENUM ('CANDIDATE', 'PROVISIONAL', 'VERIFIED', 'FORMER', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ManagerAssignmentType" AS ENUM ('PROVISIONAL', 'ELECTED', 'APPOINTED', 'BACKOFFICE_ASSIGNED');

-- CreateEnum
CREATE TYPE "MembershipRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FundType" AS ENUM ('CURRENT', 'RESERVE', 'EMERGENCY', 'RENOVATION', 'INSURANCE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ChargeCalculationMethod" AS ENUM ('FIXED', 'AREA_BASED', 'MIXED');

-- CreateEnum
CREATE TYPE "ChargeBatchStatus" AS ENUM ('DRAFT', 'ISSUED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChargeItemStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REVERSED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'PAYMENT', 'ADJUSTMENT', 'REFUND', 'CREDIT_APPLIED', 'REVERSAL');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "VoteCategory" AS ENUM ('MANAGEMENT', 'FINANCIAL', 'LEGAL', 'MAINTENANCE', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "VoteStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VoteEligibilityType" AS ENUM ('OWNER');

-- CreateEnum
CREATE TYPE "VoteResultStatus" AS ENUM ('PASSED', 'NOT_PASSED', 'QUORUM_NOT_MET');

-- CreateEnum
CREATE TYPE "VoteScopeType" AS ENUM ('ENTIRE_BUILDING', 'BLOCK', 'PROPERTY_TYPE', 'SELECTED_UNITS');

-- CreateEnum
CREATE TYPE "CaseType" AS ENUM ('MAINTENANCE', 'COMPLAINT', 'SUGGESTION', 'GENERAL');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CasePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "CaseVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "CaseResolutionCode" AS ENUM ('COMPLETED', 'REJECTED', 'DUPLICATE', 'INVALID', 'EXTERNAL_RESOLUTION', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('GOVERNANCE', 'FINANCIAL', 'LEGAL', 'MAINTENANCE', 'GENERAL');

-- CreateEnum
CREATE TYPE "DocumentVisibility" AS ENUM ('PUBLIC', 'MEMBERS_ONLY', 'MANAGEMENT_ONLY');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "DocumentReferenceEntityType" AS ENUM ('BUILDING', 'UNIT', 'VOTE', 'CHARGE_BATCH', 'PAYMENT', 'CASE', 'SERVICE_PROVIDER', 'SUPPORT_CASE');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('FINANCIAL', 'GOVERNANCE', 'CASE', 'DOCUMENT', 'MEMBERSHIP', 'SYSTEM', 'GAMIFICATION', 'VERIFICATION', 'MARKETPLACE', 'FRAUD', 'SUPPORT');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "XpReason" AS ENUM ('PROFILE_CREATED', 'BUILDING_SETUP_COMPLETED', 'CHARGE_PAID', 'VOTE_PARTICIPATED', 'CASE_RESOLVED', 'CHARGE_PAID_REVERSED');

-- CreateEnum
CREATE TYPE "AchievementCode" AS ENUM ('FIRST_STEPS', 'BUILDING_FOUNDER', 'FIRST_PAYMENT', 'FIRST_VOTE', 'COMMUNITY_HELPER');

-- CreateEnum
CREATE TYPE "LeagueTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND');

-- CreateEnum
CREATE TYPE "VerificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BuildingVerificationDecision" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_INFORMATION');

-- CreateEnum
CREATE TYPE "ManagerVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ManagerVerificationSource" AS ENUM ('OWNER_APPROVAL', 'ADMIN_REVIEW', 'ELECTION', 'RECOVERY_APPOINTMENT');

-- CreateEnum
CREATE TYPE "ManagerVerificationDecision" AS ENUM ('APPROVE', 'REJECT', 'SUSPEND', 'RESTORE');

-- CreateEnum
CREATE TYPE "PlatformStaffRole" AS ENUM ('REVIEWER', 'SENIOR_REVIEWER', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "ServiceProviderCategory" AS ENUM ('MAINTENANCE', 'PROFESSIONAL_MANAGEMENT', 'INSURANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "ServiceProviderStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FraudCaseStatus" AS ENUM ('OPEN', 'UNDER_INVESTIGATION', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "FraudCaseSource" AS ENUM ('SYSTEM_SIGNAL', 'USER_REPORT');

-- CreateEnum
CREATE TYPE "FraudSignalType" AS ENUM ('MULTIPLE_MANAGER_CLAIMS', 'MASS_REGISTRATIONS', 'SUSPICIOUS_BUILDING_CREATION', 'EXCESSIVE_APPEALS', 'ABNORMAL_ACTIVITY', 'OTHER');

-- CreateEnum
CREATE TYPE "EnforcementActionType" AS ENUM ('WARNING', 'TEMPORARY_RESTRICTION', 'VERIFICATION_REVOCATION', 'ACCOUNT_SUSPENSION');

-- CreateEnum
CREATE TYPE "EnforcementTargetType" AS ENUM ('PERSON', 'BUILDING', 'MANAGER_CLAIM');

-- CreateEnum
CREATE TYPE "EnforcementAppealStatus" AS ENUM ('NONE', 'PENDING', 'UPHELD', 'OVERTURNED');

-- CreateEnum
CREATE TYPE "SupportCaseCategory" AS ENUM ('TECHNICAL', 'BILLING', 'VERIFICATION', 'FRAUD', 'GOVERNANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportCaseResolutionCode" AS ENUM ('USER_ERROR', 'CONFIGURATION_ISSUE', 'BUG_FIXED', 'DUPLICATE_REQUEST', 'NOT_REPRODUCIBLE', 'OTHER');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionFeatureKey" AS ENUM ('BUILDING_REGISTRATION', 'PROPERTIES', 'OWNERS', 'TENANTS', 'BASIC_CHARGES', 'BASIC_PAYMENTS', 'DEBT_VIEW', 'IN_APP_NOTIFICATIONS', 'ONLINE_PAYMENT', 'DOCUMENTS', 'VOTING', 'MEETINGS', 'REQUESTS', 'REPORTS', 'FUNDS', 'ADVANCED_ACCOUNTING', 'SMS', 'EMAIL', 'PUSH_NOTIFICATIONS', 'AUTOMATION');

-- CreateEnum
CREATE TYPE "FeatureGrantType" AS ENUM ('PROMOTION', 'SUPPORT', 'PARTNERSHIP', 'TRIAL_EXTENSION', 'BETA_TESTING', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplianceCaseCategory" AS ENUM ('REPEATED_FRAUD', 'REPEATED_SUSPENSION', 'FINANCIAL_ANOMALY', 'OTHER');

-- CreateTable
CREATE TABLE "persons" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "fullName" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'fa',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "xpBalance" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "deviceToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "label" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_requests" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildings" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "buildingType" "BuildingType" NOT NULL DEFAULT 'RESIDENTIAL',
    "description" TEXT,
    "country" TEXT NOT NULL,
    "province" TEXT,
    "city" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "mainStreet" TEXT NOT NULL,
    "subStreet" TEXT,
    "alley" TEXT,
    "plateNumber" TEXT NOT NULL,
    "addressLine" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "totalBlocks" INTEGER NOT NULL DEFAULT 1,
    "totalUnits" INTEGER NOT NULL DEFAULT 1,
    "totalFloors" INTEGER,
    "status" "BuildingStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "recoveryModeEnteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "totalFloors" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floors" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT,

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "blockId" TEXT,
    "floorId" TEXT,
    "floorNumber" INTEGER,
    "unitNumber" TEXT NOT NULL,
    "type" "UnitType" NOT NULL DEFAULT 'RESIDENTIAL',
    "areaSqm" DOUBLE PRECISION,
    "parkingCount" INTEGER,
    "storageCount" INTEGER,
    "occupancyStatus" "UnitOccupancyStatus" NOT NULL DEFAULT 'VACANT',
    "ownerFullName" TEXT,
    "ownerPhone" TEXT,
    "ownerInviteSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ownerships" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ownerships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenancies" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "status" "TenancyStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "noticeGivenAt" TIMESTAMP(3),
    "terminationReason" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "unitId" TEXT,
    "role" "MembershipRole" NOT NULL,
    "managerState" "ManagerLifecycleState",
    "managerAssignmentType" "ManagerAssignmentType",
    "assignedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_requests" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "message" TEXT,
    "status" "MembershipRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funds" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FundType" NOT NULL DEFAULT 'CURRENT',
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_batches" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "calculationMethod" "ChargeCalculationMethod" NOT NULL DEFAULT 'FIXED',
    "totalAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "ChargeBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charge_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_items" (
    "id" TEXT NOT NULL,
    "chargeBatchId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "status" "ChargeItemStatus" NOT NULL DEFAULT 'UNPAID',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "reference" TEXT,
    "note" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "chargeItemId" TEXT,
    "adjustmentId" TEXT,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_balances" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" INTEGER NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "description" TEXT,
    "actorId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustments" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "votes" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "VoteCategory" NOT NULL,
    "status" "VoteStatus" NOT NULL DEFAULT 'DRAFT',
    "isManagerElection" BOOLEAN NOT NULL DEFAULT false,
    "quorumPercent" INTEGER,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "meetingId" TEXT,
    "scopeType" "VoteScopeType" NOT NULL DEFAULT 'ENTIRE_BUILDING',
    "scopeBlockId" TEXT,
    "scopeUnitType" "UnitType",
    "scopeUnitIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_options" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_eligibility_snapshots" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "eligiblePersonId" TEXT NOT NULL,
    "eligibilityType" "VoteEligibilityType" NOT NULL DEFAULT 'OWNER',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_eligibility_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ballots" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "voterPersonId" TEXT NOT NULL,
    "selectedOptionId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ballots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_results" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "totalEligibleCount" INTEGER NOT NULL,
    "totalBallotCount" INTEGER NOT NULL,
    "quorumMet" BOOLEAN NOT NULL,
    "winningOptionId" TEXT,
    "resultStatus" "VoteResultStatus" NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "vote_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "minutes" TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_attendances" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cases" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "unitId" TEXT,
    "type" "CaseType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "CasePriority" NOT NULL DEFAULT 'NORMAL',
    "visibility" "CaseVisibility" NOT NULL DEFAULT 'PRIVATE',
    "isAgainstManager" BOOLEAN NOT NULL DEFAULT false,
    "resolutionCode" "CaseResolutionCode",
    "createdById" TEXT NOT NULL,
    "assigneeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "mergedIntoId" TEXT,

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_messages" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_assignments" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "note" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "DocumentVisibility" NOT NULL DEFAULT 'MEMBERS_ONLY',
    "status" "DocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_references" (
    "id" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "entityType" "DocumentReferenceEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_downloads" (
    "id" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "downloadedById" TEXT NOT NULL,
    "downloadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_downloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "buildingId" TEXT,
    "category" "NotificationCategory" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "sourceEvent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "marketingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "titleTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xp_transactions" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "buildingId" TEXT,
    "reason" "XpReason" NOT NULL,
    "amount" INTEGER NOT NULL,
    "sourceEvent" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievement_definitions" (
    "id" TEXT NOT NULL,
    "code" "AchievementCode" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "xpBonus" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "achievement_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_achievements" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "buildingId" TEXT,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "building_scores" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "leagueTier" "LeagueTier" NOT NULL DEFAULT 'BRONZE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "building_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "building_score_events" (
    "id" TEXT NOT NULL,
    "buildingScoreId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceEvent" TEXT,
    "previousTier" "LeagueTier" NOT NULL,
    "newTier" "LeagueTier" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "building_score_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "building_verification_cases" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "status" "BuildingStatus" NOT NULL,
    "priority" "VerificationPriority" NOT NULL DEFAULT 'NORMAL',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isAppeal" BOOLEAN NOT NULL DEFAULT false,
    "previousCaseId" TEXT,
    "assignedToId" TEXT,
    "reviewedById" TEXT,
    "decision" "BuildingVerificationDecision",
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "building_verification_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_verification_cases" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "ManagerVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verificationSource" "ManagerVerificationSource",
    "decision" "ManagerVerificationDecision",
    "priority" "VerificationPriority" NOT NULL DEFAULT 'NORMAL',
    "requiredApprovalPercent" INTEGER NOT NULL DEFAULT 30,
    "isReverification" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" TEXT,
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manager_verification_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_verification_approvals" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "ownerPersonId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_verification_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_staff" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "PlatformStaffRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ServiceProviderCategory" NOT NULL,
    "description" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "city" TEXT,
    "status" "ServiceProviderStatus" NOT NULL DEFAULT 'PENDING',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "submittedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_cases" (
    "id" TEXT NOT NULL,
    "status" "FraudCaseStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "VerificationPriority" NOT NULL DEFAULT 'NORMAL',
    "source" "FraudCaseSource" NOT NULL,
    "signalType" "FraudSignalType",
    "reportedById" TEXT,
    "targetPersonId" TEXT,
    "targetBuildingId" TEXT,
    "description" TEXT,
    "evidenceNotes" TEXT,
    "assignedToId" TEXT,
    "reviewedById" TEXT,
    "reason" TEXT,
    "isReopen" BOOLEAN NOT NULL DEFAULT false,
    "previousCaseId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fraud_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enforcement_actions" (
    "id" TEXT NOT NULL,
    "fraudCaseId" TEXT NOT NULL,
    "type" "EnforcementActionType" NOT NULL,
    "targetType" "EnforcementTargetType" NOT NULL,
    "targetPersonId" TEXT,
    "targetBuildingId" TEXT,
    "targetMembershipId" TEXT,
    "reason" TEXT,
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appealStatus" "EnforcementAppealStatus" NOT NULL DEFAULT 'NONE',
    "appealReason" TEXT,
    "appealedAt" TIMESTAMP(3),
    "appealDecidedById" TEXT,
    "appealDecidedAt" TIMESTAMP(3),

    CONSTRAINT "enforcement_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_cases" (
    "id" TEXT NOT NULL,
    "category" "SupportCaseCategory" NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "VerificationPriority" NOT NULL DEFAULT 'NORMAL',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "linkedEntityType" TEXT,
    "linkedEntityId" TEXT,
    "resolutionCode" "SupportCaseResolutionCode",
    "resolution" TEXT,
    "mergedIntoId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_case_messages" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_case_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "trialEndsAt" TIMESTAMP(3),
    "trialUsed" BOOLEAN NOT NULL DEFAULT false,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 7,
    "currentPeriodEndsAt" TIMESTAMP(3),
    "gracePeriodEndsAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_grants" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "featureKey" "SubscriptionFeatureKey" NOT NULL,
    "grantType" "FeatureGrantType" NOT NULL,
    "reason" TEXT,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "feature_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_change_logs" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "fromPlan" "SubscriptionPlan",
    "toPlan" "SubscriptionPlan",
    "fromStatus" "SubscriptionStatus",
    "toStatus" "SubscriptionStatus",
    "changedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "building_setup_drafts" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "device" TEXT,
    "step" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "building_setup_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "buildingId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_cases" (
    "id" TEXT NOT NULL,
    "category" "ComplianceCaseCategory" NOT NULL,
    "status" "FraudCaseStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "VerificationPriority" NOT NULL DEFAULT 'NORMAL',
    "subjectActorId" TEXT,
    "linkedEntityType" TEXT,
    "linkedEntityId" TEXT,
    "sourceAuditLogIds" TEXT[],
    "description" TEXT NOT NULL,
    "findings" TEXT,
    "isAutoDetected" BOOLEAN NOT NULL DEFAULT false,
    "openedById" TEXT,
    "assignedToId" TEXT,
    "decidedById" TEXT,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_legal_holds" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "placedById" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "audit_legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "persons_phone_key" ON "persons"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "persons_email_key" ON "persons"("email");

-- CreateIndex
CREATE UNIQUE INDEX "devices_deviceToken_key" ON "devices"("deviceToken");

-- CreateIndex
CREATE INDEX "devices_personId_idx" ON "devices"("personId");

-- CreateIndex
CREATE INDEX "otp_requests_phone_purpose_idx" ON "otp_requests"("phone", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_personId_idx" ON "refresh_tokens"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "buildings_postalCode_key" ON "buildings"("postalCode");

-- CreateIndex
CREATE INDEX "blocks_buildingId_idx" ON "blocks"("buildingId");

-- CreateIndex
CREATE INDEX "floors_blockId_idx" ON "floors"("blockId");

-- CreateIndex
CREATE INDEX "units_buildingId_idx" ON "units"("buildingId");

-- CreateIndex
CREATE UNIQUE INDEX "units_buildingId_unitNumber_key" ON "units"("buildingId", "unitNumber");

-- CreateIndex
CREATE INDEX "ownerships_unitId_idx" ON "ownerships"("unitId");

-- CreateIndex
CREATE INDEX "ownerships_personId_idx" ON "ownerships"("personId");

-- CreateIndex
CREATE INDEX "tenancies_unitId_idx" ON "tenancies"("unitId");

-- CreateIndex
CREATE INDEX "tenancies_personId_idx" ON "tenancies"("personId");

-- CreateIndex
CREATE INDEX "memberships_buildingId_idx" ON "memberships"("buildingId");

-- CreateIndex
CREATE INDEX "memberships_personId_idx" ON "memberships"("personId");

-- CreateIndex
CREATE INDEX "memberships_buildingId_role_isCurrent_idx" ON "memberships"("buildingId", "role", "isCurrent");

-- CreateIndex
CREATE INDEX "membership_requests_buildingId_idx" ON "membership_requests"("buildingId");

-- CreateIndex
CREATE INDEX "membership_requests_personId_idx" ON "membership_requests"("personId");

-- CreateIndex
CREATE INDEX "funds_buildingId_idx" ON "funds"("buildingId");

-- CreateIndex
CREATE UNIQUE INDEX "funds_buildingId_name_key" ON "funds"("buildingId", "name");

-- CreateIndex
CREATE INDEX "charge_batches_buildingId_idx" ON "charge_batches"("buildingId");

-- CreateIndex
CREATE INDEX "charge_batches_buildingId_status_idx" ON "charge_batches"("buildingId", "status");

-- CreateIndex
CREATE INDEX "charge_items_chargeBatchId_idx" ON "charge_items"("chargeBatchId");

-- CreateIndex
CREATE INDEX "charge_items_unitId_idx" ON "charge_items"("unitId");

-- CreateIndex
CREATE INDEX "charge_items_unitId_status_idx" ON "charge_items"("unitId", "status");

-- CreateIndex
CREATE INDEX "payments_buildingId_idx" ON "payments"("buildingId");

-- CreateIndex
CREATE INDEX "payments_unitId_idx" ON "payments"("unitId");

-- CreateIndex
CREATE INDEX "payments_buildingId_status_idx" ON "payments"("buildingId", "status");

-- CreateIndex
CREATE INDEX "payment_allocations_paymentId_idx" ON "payment_allocations"("paymentId");

-- CreateIndex
CREATE INDEX "payment_allocations_chargeItemId_idx" ON "payment_allocations"("chargeItemId");

-- CreateIndex
CREATE INDEX "payment_allocations_adjustmentId_idx" ON "payment_allocations"("adjustmentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_paymentId_chargeItemId_key" ON "payment_allocations"("paymentId", "chargeItemId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_paymentId_adjustmentId_key" ON "payment_allocations"("paymentId", "adjustmentId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_balances_unitId_key" ON "credit_balances"("unitId");

-- CreateIndex
CREATE INDEX "credit_balances_buildingId_idx" ON "credit_balances"("buildingId");

-- CreateIndex
CREATE INDEX "ledger_entries_buildingId_idx" ON "ledger_entries"("buildingId");

-- CreateIndex
CREATE INDEX "ledger_entries_fundId_idx" ON "ledger_entries"("fundId");

-- CreateIndex
CREATE INDEX "ledger_entries_referenceType_referenceId_idx" ON "ledger_entries"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "adjustments_unitId_idx" ON "adjustments"("unitId");

-- CreateIndex
CREATE INDEX "adjustments_buildingId_idx" ON "adjustments"("buildingId");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE INDEX "refunds_buildingId_idx" ON "refunds"("buildingId");

-- CreateIndex
CREATE INDEX "votes_buildingId_idx" ON "votes"("buildingId");

-- CreateIndex
CREATE INDEX "votes_buildingId_status_idx" ON "votes"("buildingId", "status");

-- CreateIndex
CREATE INDEX "votes_meetingId_idx" ON "votes"("meetingId");

-- CreateIndex
CREATE INDEX "votes_scopeBlockId_idx" ON "votes"("scopeBlockId");

-- CreateIndex
CREATE INDEX "vote_options_voteId_idx" ON "vote_options"("voteId");

-- CreateIndex
CREATE INDEX "vote_eligibility_snapshots_voteId_idx" ON "vote_eligibility_snapshots"("voteId");

-- CreateIndex
CREATE UNIQUE INDEX "vote_eligibility_snapshots_voteId_unitId_key" ON "vote_eligibility_snapshots"("voteId", "unitId");

-- CreateIndex
CREATE INDEX "ballots_voteId_idx" ON "ballots"("voteId");

-- CreateIndex
CREATE UNIQUE INDEX "ballots_voteId_unitId_key" ON "ballots"("voteId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "vote_results_voteId_key" ON "vote_results"("voteId");

-- CreateIndex
CREATE INDEX "meetings_buildingId_idx" ON "meetings"("buildingId");

-- CreateIndex
CREATE INDEX "meeting_attendances_meetingId_idx" ON "meeting_attendances"("meetingId");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_attendances_meetingId_personId_key" ON "meeting_attendances"("meetingId", "personId");

-- CreateIndex
CREATE INDEX "cases_buildingId_idx" ON "cases"("buildingId");

-- CreateIndex
CREATE INDEX "cases_buildingId_status_idx" ON "cases"("buildingId", "status");

-- CreateIndex
CREATE INDEX "cases_buildingId_type_idx" ON "cases"("buildingId", "type");

-- CreateIndex
CREATE INDEX "case_messages_caseId_idx" ON "case_messages"("caseId");

-- CreateIndex
CREATE INDEX "case_assignments_caseId_idx" ON "case_assignments"("caseId");

-- CreateIndex
CREATE INDEX "documents_buildingId_idx" ON "documents"("buildingId");

-- CreateIndex
CREATE INDEX "documents_buildingId_category_idx" ON "documents"("buildingId", "category");

-- CreateIndex
CREATE INDEX "documents_buildingId_status_idx" ON "documents"("buildingId", "status");

-- CreateIndex
CREATE INDEX "document_versions_documentId_idx" ON "document_versions"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentId_versionNumber_key" ON "document_versions"("documentId", "versionNumber");

-- CreateIndex
CREATE INDEX "document_references_entityType_entityId_idx" ON "document_references"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "document_references_documentVersionId_idx" ON "document_references"("documentVersionId");

-- CreateIndex
CREATE INDEX "document_downloads_documentVersionId_idx" ON "document_downloads"("documentVersionId");

-- CreateIndex
CREATE INDEX "notifications_recipientId_idx" ON "notifications"("recipientId");

-- CreateIndex
CREATE INDEX "notifications_recipientId_readAt_idx" ON "notifications"("recipientId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_buildingId_idx" ON "notifications"("buildingId");

-- CreateIndex
CREATE INDEX "notification_deliveries_notificationId_idx" ON "notification_deliveries"("notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_personId_key" ON "notification_preferences"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_code_key" ON "notification_templates"("code");

-- CreateIndex
CREATE INDEX "xp_transactions_personId_idx" ON "xp_transactions"("personId");

-- CreateIndex
CREATE INDEX "xp_transactions_personId_reason_idx" ON "xp_transactions"("personId", "reason");

-- CreateIndex
CREATE INDEX "xp_transactions_referenceType_referenceId_idx" ON "xp_transactions"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_definitions_code_key" ON "achievement_definitions"("code");

-- CreateIndex
CREATE INDEX "person_achievements_personId_idx" ON "person_achievements"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "person_achievements_personId_definitionId_key" ON "person_achievements"("personId", "definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "building_scores_buildingId_key" ON "building_scores"("buildingId");

-- CreateIndex
CREATE INDEX "building_score_events_buildingScoreId_idx" ON "building_score_events"("buildingScoreId");

-- CreateIndex
CREATE INDEX "building_verification_cases_buildingId_idx" ON "building_verification_cases"("buildingId");

-- CreateIndex
CREATE INDEX "building_verification_cases_status_priority_idx" ON "building_verification_cases"("status", "priority");

-- CreateIndex
CREATE INDEX "manager_verification_cases_buildingId_idx" ON "manager_verification_cases"("buildingId");

-- CreateIndex
CREATE INDEX "manager_verification_cases_membershipId_idx" ON "manager_verification_cases"("membershipId");

-- CreateIndex
CREATE INDEX "manager_verification_cases_status_priority_idx" ON "manager_verification_cases"("status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "manager_verification_approvals_caseId_ownerPersonId_key" ON "manager_verification_approvals"("caseId", "ownerPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_staff_personId_key" ON "platform_staff"("personId");

-- CreateIndex
CREATE INDEX "service_providers_status_category_idx" ON "service_providers"("status", "category");

-- CreateIndex
CREATE INDEX "fraud_cases_status_priority_idx" ON "fraud_cases"("status", "priority");

-- CreateIndex
CREATE INDEX "fraud_cases_targetPersonId_idx" ON "fraud_cases"("targetPersonId");

-- CreateIndex
CREATE INDEX "fraud_cases_targetBuildingId_idx" ON "fraud_cases"("targetBuildingId");

-- CreateIndex
CREATE INDEX "enforcement_actions_fraudCaseId_idx" ON "enforcement_actions"("fraudCaseId");

-- CreateIndex
CREATE INDEX "enforcement_actions_targetPersonId_idx" ON "enforcement_actions"("targetPersonId");

-- CreateIndex
CREATE INDEX "enforcement_actions_targetBuildingId_idx" ON "enforcement_actions"("targetBuildingId");

-- CreateIndex
CREATE INDEX "support_cases_status_priority_idx" ON "support_cases"("status", "priority");

-- CreateIndex
CREATE INDEX "support_cases_createdById_idx" ON "support_cases"("createdById");

-- CreateIndex
CREATE INDEX "support_cases_assignedToId_idx" ON "support_cases"("assignedToId");

-- CreateIndex
CREATE INDEX "support_case_messages_caseId_idx" ON "support_case_messages"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_buildingId_key" ON "subscriptions"("buildingId");

-- CreateIndex
CREATE INDEX "feature_grants_subscriptionId_idx" ON "feature_grants"("subscriptionId");

-- CreateIndex
CREATE INDEX "feature_grants_subscriptionId_featureKey_idx" ON "feature_grants"("subscriptionId", "featureKey");

-- CreateIndex
CREATE INDEX "subscription_change_logs_subscriptionId_idx" ON "subscription_change_logs"("subscriptionId");

-- CreateIndex
CREATE INDEX "building_setup_drafts_personId_idx" ON "building_setup_drafts"("personId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_buildingId_idx" ON "audit_logs"("buildingId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "compliance_cases_subjectActorId_idx" ON "compliance_cases"("subjectActorId");

-- CreateIndex
CREATE INDEX "compliance_cases_status_idx" ON "compliance_cases"("status");

-- CreateIndex
CREATE INDEX "compliance_cases_linkedEntityType_linkedEntityId_idx" ON "compliance_cases"("linkedEntityType", "linkedEntityId");

-- CreateIndex
CREATE INDEX "audit_legal_holds_entityType_entityId_idx" ON "audit_legal_holds"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "floors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenancies" ADD CONSTRAINT "tenancies_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenancies" ADD CONSTRAINT "tenancies_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_requests" ADD CONSTRAINT "membership_requests_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_requests" ADD CONSTRAINT "membership_requests_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funds" ADD CONSTRAINT "funds_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_batches" ADD CONSTRAINT "charge_batches_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_batches" ADD CONSTRAINT "charge_batches_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_batches" ADD CONSTRAINT "charge_batches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_items" ADD CONSTRAINT "charge_items_chargeBatchId_fkey" FOREIGN KEY ("chargeBatchId") REFERENCES "charge_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_items" ADD CONSTRAINT "charge_items_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_chargeItemId_fkey" FOREIGN KEY ("chargeItemId") REFERENCES "charge_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "funds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_scopeBlockId_fkey" FOREIGN KEY ("scopeBlockId") REFERENCES "blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_options" ADD CONSTRAINT "vote_options_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "votes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_eligibility_snapshots" ADD CONSTRAINT "vote_eligibility_snapshots_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "votes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_eligibility_snapshots" ADD CONSTRAINT "vote_eligibility_snapshots_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_eligibility_snapshots" ADD CONSTRAINT "vote_eligibility_snapshots_eligiblePersonId_fkey" FOREIGN KEY ("eligiblePersonId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "votes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_voterPersonId_fkey" FOREIGN KEY ("voterPersonId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_selectedOptionId_fkey" FOREIGN KEY ("selectedOptionId") REFERENCES "vote_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_results" ADD CONSTRAINT "vote_results_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "votes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_results" ADD CONSTRAINT "vote_results_winningOptionId_fkey" FOREIGN KEY ("winningOptionId") REFERENCES "vote_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendances" ADD CONSTRAINT "meeting_attendances_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendances" ADD CONSTRAINT "meeting_attendances_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_messages" ADD CONSTRAINT "case_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_assignments" ADD CONSTRAINT "case_assignments_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_assignments" ADD CONSTRAINT "case_assignments_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_assignments" ADD CONSTRAINT "case_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_references" ADD CONSTRAINT "document_references_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_downloads" ADD CONSTRAINT "document_downloads_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_downloads" ADD CONSTRAINT "document_downloads_downloadedById_fkey" FOREIGN KEY ("downloadedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xp_transactions" ADD CONSTRAINT "xp_transactions_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xp_transactions" ADD CONSTRAINT "xp_transactions_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_achievements" ADD CONSTRAINT "person_achievements_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_achievements" ADD CONSTRAINT "person_achievements_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "achievement_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_achievements" ADD CONSTRAINT "person_achievements_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_scores" ADD CONSTRAINT "building_scores_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_score_events" ADD CONSTRAINT "building_score_events_buildingScoreId_fkey" FOREIGN KEY ("buildingScoreId") REFERENCES "building_scores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_verification_cases" ADD CONSTRAINT "building_verification_cases_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_verification_cases" ADD CONSTRAINT "building_verification_cases_previousCaseId_fkey" FOREIGN KEY ("previousCaseId") REFERENCES "building_verification_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_verification_cases" ADD CONSTRAINT "building_verification_cases_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_verification_cases" ADD CONSTRAINT "building_verification_cases_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_verification_cases" ADD CONSTRAINT "manager_verification_cases_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_verification_cases" ADD CONSTRAINT "manager_verification_cases_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_verification_cases" ADD CONSTRAINT "manager_verification_cases_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_verification_cases" ADD CONSTRAINT "manager_verification_cases_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_verification_approvals" ADD CONSTRAINT "manager_verification_approvals_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "manager_verification_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_verification_approvals" ADD CONSTRAINT "manager_verification_approvals_ownerPersonId_fkey" FOREIGN KEY ("ownerPersonId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_staff" ADD CONSTRAINT "platform_staff_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_providers" ADD CONSTRAINT "service_providers_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_cases" ADD CONSTRAINT "fraud_cases_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_cases" ADD CONSTRAINT "fraud_cases_targetPersonId_fkey" FOREIGN KEY ("targetPersonId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_cases" ADD CONSTRAINT "fraud_cases_targetBuildingId_fkey" FOREIGN KEY ("targetBuildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_cases" ADD CONSTRAINT "fraud_cases_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_cases" ADD CONSTRAINT "fraud_cases_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_cases" ADD CONSTRAINT "fraud_cases_previousCaseId_fkey" FOREIGN KEY ("previousCaseId") REFERENCES "fraud_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_actions" ADD CONSTRAINT "enforcement_actions_fraudCaseId_fkey" FOREIGN KEY ("fraudCaseId") REFERENCES "fraud_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_actions" ADD CONSTRAINT "enforcement_actions_targetPersonId_fkey" FOREIGN KEY ("targetPersonId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_actions" ADD CONSTRAINT "enforcement_actions_targetBuildingId_fkey" FOREIGN KEY ("targetBuildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_actions" ADD CONSTRAINT "enforcement_actions_targetMembershipId_fkey" FOREIGN KEY ("targetMembershipId") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_actions" ADD CONSTRAINT "enforcement_actions_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_actions" ADD CONSTRAINT "enforcement_actions_appealDecidedById_fkey" FOREIGN KEY ("appealDecidedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "support_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_case_messages" ADD CONSTRAINT "support_case_messages_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "support_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_case_messages" ADD CONSTRAINT "support_case_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_grants" ADD CONSTRAINT "feature_grants_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_grants" ADD CONSTRAINT "feature_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_grants" ADD CONSTRAINT "feature_grants_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_change_logs" ADD CONSTRAINT "subscription_change_logs_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_change_logs" ADD CONSTRAINT "subscription_change_logs_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_setup_drafts" ADD CONSTRAINT "building_setup_drafts_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_cases" ADD CONSTRAINT "compliance_cases_subjectActorId_fkey" FOREIGN KEY ("subjectActorId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_cases" ADD CONSTRAINT "compliance_cases_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_cases" ADD CONSTRAINT "compliance_cases_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_cases" ADD CONSTRAINT "compliance_cases_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_legal_holds" ADD CONSTRAINT "audit_legal_holds_placedById_fkey" FOREIGN KEY ("placedById") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_legal_holds" ADD CONSTRAINT "audit_legal_holds_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

