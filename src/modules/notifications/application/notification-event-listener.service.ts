import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { MembershipRole } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import type { BuildingCreatedEvent } from '../../building/events/building-created.event';
import type { ManagerChangedEvent } from '../../building/events/manager-changed.event';
import type { OwnershipTransferInitiatedEvent } from '../../building/events/ownership-transferred.event';
import type { TenancyCreatedEvent, TenancyEndedEvent } from '../../building/events/tenancy.events';
import type { PersonAuthenticatedEvent } from '../../foundation/auth/events/person-authenticated.event';
import type { ChargeBatchCancelledEvent, ChargeBatchIssuedEvent } from '../../finance/events/charge-batch.events';
import type { PaymentApprovedEvent, PaymentRefundedEvent, PaymentRejectedEvent, PaymentReversedEvent } from '../../finance/events/payment.events';
import type { AdjustmentCreatedEvent } from '../../finance/events/adjustment.events';
import type { VoteCancelledEvent, VoteClosedEvent, VotePublishedEvent } from '../../governance/events/vote.events';
import type { CaseAssignedEvent, CaseCreatedEvent, CaseStatusChangedEvent } from '../../cases/events/case.events';
import type { DocumentUploadedEvent } from '../../documents/events/document.events';
import type {
  AchievementUnlockedEvent,
  LeagueTierChangedEvent,
  XpAwardedEvent,
} from '../../gamification/events/gamification.events';
import type {
  BuildingVerificationDecidedEvent,
  EnforcementActionIssuedEvent,
  FraudCaseDecidedEvent,
  ManagerVerificationDecidedEvent,
  SupportCaseResolvedEvent,
} from '../../backoffice/events/backoffice.events';
import type { ServiceProviderDecidedEvent } from '../../marketplace/events/marketplace.events';

/** 08.08 Rule 008 / ADR-025's assignable-to set — reused here for "who should triage a new/changed Case." */
const PRIVILEGED_ROLES: MembershipRole[] = ['MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT'];

/** ADR-026's DocumentPolicy privileged-category set — reused so a Document-upload broadcast reaches the same audience that can actually read/manage that category. */
const PRIVILEGED_DOCUMENT_CATEGORIES = ['GOVERNANCE', 'FINANCIAL', 'LEGAL'];

/**
 * Reacts to domain events already emitted across every other module
 * (Building, Auth, Finance, Governance, Cases, Documents, Gamification as
 * of ADR-028, BackOffice as of ADR-029, Marketplace as of ADR-030,
 * BackOffice's own Fraud & Abuse Center as of ADR-031 and Support &
 * Operations Center as of ADR-032, and Building's own Ownership Transfer
 * / Tenancy as of ADR-035, plus Finance's own Adjustment/Reversal/Refund
 * events as of ADR-042) and turns them into Notifications — this
 * is the "listener" side of the Event Pipeline (`DomainEvent`'s own doc
 * comment: "listeners react ... without coupling the domain to them"). No
 * other module imports this one, and this module imports only
 * `BuildingModule` (for recipient resolution) — the emitting modules
 * never know a Notification listener exists, exactly as designed.
 *
 * Event types are imported with `import type` only — a compile-time-only
 * reference, not a runtime module dependency, so this doesn't require
 * importing FinanceModule/GovernanceModule/CasesModule/DocumentsModule/
 * GamificationModule into `NotificationsModule`.
 *
 * Not every domain event gets a listener here — see 21_ADRs > ADR-027
 * Decision/Future Review for the explicit list of what's deliberately
 * deferred (UnitCreatedEvent has nothing notify-worthy; DocumentVersion
 * CreatedEvent/DocumentArchivedEvent/DocumentReferenceCreatedEvent are
 * lower-signal for this MVP pass). BallotCastEvent itself is still not
 * wired here even though ADR-028 gave it a `voterPersonId` — a per-vote
 * "you voted" confirmation wasn't asked for and stays deferred; the field
 * was added for Gamification's XP attribution, not for this module.
 * `BuildingScoreChangedEvent` is also deliberately NOT wired here — see
 * that event's own doc comment in `gamification.events.ts`.
 */
@Injectable()
export class NotificationEventListener {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly buildings: BuildingRepository,
  ) {}

  @OnEvent('BuildingCreated')
  async onBuildingCreated(event: BuildingCreatedEvent) {
    await this.notifications.notify({
      recipientId: event.createdById,
      buildingId: event.buildingId,
      category: 'SYSTEM',
      title: 'به VielHome خوش آمدید',
      body: 'ساختمان شما با موفقیت ثبت شد.',
      referenceType: 'BUILDING',
      referenceId: event.buildingId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('PersonAuthenticated')
  async onPersonAuthenticated(event: PersonAuthenticatedEvent) {
    if (!event.isNewPerson) return;
    await this.notifications.notify({
      recipientId: event.personId,
      category: 'SYSTEM',
      title: 'به VielHome خوش آمدید',
      body: 'حساب کاربری شما با موفقیت ایجاد شد.',
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('ManagerChanged')
  async onManagerChanged(event: ManagerChangedEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'MEMBERSHIP',
      title: 'تغییر مدیر ساختمان',
      body: 'مدیر جدیدی برای ساختمان شما تعیین شد.',
      referenceType: 'BUILDING',
      referenceId: event.buildingId,
      sourceEvent: event.eventName,
    });
  }

  /**
   * 21_ADRs > ADR-035 — broadcasts to current members the same way
   * ManagerChanged does (a unit changing hands is building-wide-visible
   * information, not a precise-recipient case); the incoming owner isn't
   * reachable by Person id yet at this point (only a phone number — the
   * transfer completes asynchronously on their next OTP verify), so they
   * are not notified directly here, the same broadcast-fallback shape
   * already disclosed for VotePublished/CaseStatusChanged (ADR-027).
   */
  @OnEvent('OwnershipTransferInitiated')
  async onOwnershipTransferInitiated(event: OwnershipTransferInitiatedEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'MEMBERSHIP',
      title: 'انتقال مالکیت واحد',
      body: 'مالکیت یکی از واحدهای ساختمان شما در حال انتقال است.',
      referenceType: 'UNIT',
      referenceId: event.unitId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('TenancyCreated')
  async onTenancyCreated(event: TenancyCreatedEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'MEMBERSHIP',
      title: 'مستأجر جدید',
      body: 'یک مستأجر جدید برای یکی از واحدهای ساختمان ثبت شد.',
      referenceType: 'UNIT',
      referenceId: event.unitId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('TenancyEnded')
  async onTenancyEnded(event: TenancyEndedEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'MEMBERSHIP',
      title: 'پایان اجاره‌نشینی',
      body: 'یک اجاره‌نشینی در ساختمان شما پایان یافت.',
      referenceType: 'UNIT',
      referenceId: event.unitId,
      sourceEvent: event.eventName,
    });
  }

  /**
   * ADR-029 — replaces the old (never-notified-in-practice) `ManagerVerified`
   * event, and now also covers REJECTED/SUSPENDED so a candidate manager is
   * told either way, not just on approval.
   */
  @OnEvent('ManagerVerificationDecided')
  async onManagerVerificationDecided(event: ManagerVerificationDecidedEvent) {
    const copy: Record<string, { title: string; body: string }> = {
      VERIFIED: { title: 'تأیید سمت مدیریت', body: 'سمت مدیریت شما تأیید شد.' },
      REJECTED: { title: 'رد درخواست مدیریت', body: 'درخواست تصدی سمت مدیریت شما رد شد.' },
      SUSPENDED: { title: 'تعلیق سمت مدیریت', body: 'سمت مدیریت شما تا بررسی مجدد به حالت تعلیق درآمد.' },
    };
    const message = copy[event.status];
    if (!message) return;

    await this.notifications.notify({
      recipientId: event.candidatePersonId,
      buildingId: event.buildingId,
      category: 'VERIFICATION',
      title: message.title,
      body: message.body,
      referenceType: 'BUILDING',
      referenceId: event.buildingId,
      sourceEvent: event.eventName,
    });
  }

  /**
   * ADR-029 — a building's creator learns whether their building was
   * auto-approved or requires further review/was rejected. Only the
   * final outcomes (VERIFIED/REJECTED) reach here — `UNDER_REVIEW`/
   * `PENDING_INFORMATION` don't emit this event (see `BuildingVerificationService`).
   */
  @OnEvent('BuildingVerificationDecided')
  async onBuildingVerificationDecided(event: BuildingVerificationDecidedEvent) {
    const copy: Record<string, { title: string; body: string }> = {
      VERIFIED: { title: 'تأیید ساختمان', body: 'ساختمان شما تأیید و فعال شد.' },
      REJECTED: { title: 'رد تأیید ساختمان', body: 'درخواست تأیید ساختمان شما رد شد.' },
    };
    const message = copy[event.status];
    if (!message) return;

    await this.notifications.notify({
      recipientId: event.creatorPersonId,
      buildingId: event.buildingId,
      category: 'VERIFICATION',
      title: message.title,
      body: message.body,
      referenceType: 'BUILDING',
      referenceId: event.buildingId,
      sourceEvent: event.eventName,
    });
  }

  /** ADR-030 — a Marketplace listing's submitter learns the moderation outcome. Not building-scoped (Marketplace is platform-wide, see that schema section's header comment), so `buildingId` is omitted. */
  @OnEvent('ServiceProviderDecided')
  async onServiceProviderDecided(event: ServiceProviderDecidedEvent) {
    const copy: Record<string, { title: string; body: string }> = {
      APPROVED: { title: 'تأیید ثبت در بازارچهٔ خدمات', body: 'درخواست شما برای ثبت در بازارچهٔ خدمات تأیید شد.' },
      REJECTED: { title: 'رد ثبت در بازارچهٔ خدمات', body: 'درخواست شما برای ثبت در بازارچهٔ خدمات رد شد.' },
    };
    const message = copy[event.status];
    if (!message) return;

    await this.notifications.notify({
      recipientId: event.submittedById,
      category: 'MARKETPLACE',
      title: message.title,
      body: message.body,
      referenceType: 'SERVICE_PROVIDER',
      referenceId: event.providerId,
      sourceEvent: event.eventName,
    });
  }

  /** ADR-031 — the original reporter (if any; SYSTEM_SIGNAL cases have none) learns the investigation's outcome (07.03 Rule 011). Not building-scoped — a fraud case may target a Person with no building context. */
  @OnEvent('FraudCaseDecided')
  async onFraudCaseDecided(event: FraudCaseDecidedEvent) {
    if (!event.reporterPersonId) return;
    const copy: Record<string, { title: string; body: string }> = {
      CONFIRMED: { title: 'گزارش شما تأیید شد', body: 'گزارش تخلف شما پس از بررسی تأیید شد.' },
      DISMISSED: { title: 'گزارش شما رد شد', body: 'گزارش تخلف شما پس از بررسی رد شد.' },
    };
    const message = copy[event.status];
    if (!message) return;

    await this.notifications.notify({
      recipientId: event.reporterPersonId,
      category: 'FRAUD',
      title: message.title,
      body: message.body,
      referenceType: 'FRAUD_CASE',
      referenceId: event.caseId,
      sourceEvent: event.eventName,
    });
  }

  /** ADR-031 — the sanctioned Person is told an enforcement action was issued against them, so they can exercise their appeal right (07.03 Rule 019). HIGH priority — this can restrict what they can do on the platform. */
  @OnEvent('EnforcementActionIssued')
  async onEnforcementActionIssued(event: EnforcementActionIssuedEvent) {
    await this.notifications.notify({
      recipientId: event.targetPersonId,
      category: 'FRAUD',
      priority: 'HIGH',
      title: 'اقدام انضباطی صادر شد',
      body: 'یک اقدام انضباطی علیه حساب شما صادر شده است. برای جزئیات و امکان تجدیدنظر به بخش مربوطه مراجعه کنید.',
      referenceType: 'ENFORCEMENT_ACTION',
      referenceId: event.actionId,
      sourceEvent: event.eventName,
    });
  }

  /** ADR-032 — the ticket's own creator learns staff resolved it (07.05 Rule 010). No notification on every message reply this sprint — see NotificationEventListener's class doc comment and ADR-032 Decision for why (spam risk, no "unread messages" concept yet). */
  @OnEvent('SupportCaseResolved')
  async onSupportCaseResolved(event: SupportCaseResolvedEvent) {
    await this.notifications.notify({
      recipientId: event.createdById,
      category: 'SUPPORT',
      title: 'تیکت پشتیبانی حل شد',
      body: 'تیکت پشتیبانی شما بررسی و حل شد.',
      referenceType: 'SUPPORT_CASE',
      referenceId: event.caseId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('ChargeBatchIssued')
  async onChargeBatchIssued(event: ChargeBatchIssuedEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'FINANCIAL',
      priority: 'HIGH',
      title: 'شارژ جدید صادر شد',
      body: 'یک دوره شارژ جدید برای ساختمان شما صادر شده است.',
      referenceType: 'CHARGE_BATCH',
      referenceId: event.chargeBatchId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('ChargeBatchCancelled')
  async onChargeBatchCancelled(event: ChargeBatchCancelledEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'FINANCIAL',
      title: 'دوره شارژ لغو شد',
      body: 'یک دوره شارژ برای ساختمان شما لغو شد.',
      referenceType: 'CHARGE_BATCH',
      referenceId: event.chargeBatchId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('PaymentApproved')
  async onPaymentApproved(event: PaymentApprovedEvent) {
    const ownerIds = await this.buildings.getCurrentOwnerPersonIds(event.unitId);
    await this.notifications.notifyMany(ownerIds, {
      buildingId: event.buildingId,
      category: 'FINANCIAL',
      title: 'پرداخت تأیید شد',
      body: 'پرداخت گزارش‌شده شما تأیید شد.',
      referenceType: 'PAYMENT',
      referenceId: event.paymentId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('PaymentRejected')
  async onPaymentRejected(event: PaymentRejectedEvent) {
    const ownerIds = await this.buildings.getCurrentOwnerPersonIds(event.unitId);
    await this.notifications.notifyMany(ownerIds, {
      buildingId: event.buildingId,
      category: 'FINANCIAL',
      priority: 'HIGH',
      title: 'پرداخت رد شد',
      body: 'پرداخت گزارش‌شده شما رد شد.',
      referenceType: 'PAYMENT',
      referenceId: event.paymentId,
      sourceEvent: event.eventName,
    });
  }

  /**
   * 21_ADRs > ADR-042 — `AdjustmentCreatedEvent`/`PaymentReversedEvent`/
   * `PaymentRefundedEvent` have all been emitted since ADR-037 (Sprint 15)
   * but deliberately left unwired here, the same "emit now, wire later"
   * precedent `PaymentApprovedEvent`/`PaymentRejectedEvent` themselves
   * followed between ADR-023 and ADR-027. All three reuse the exact same
   * `getCurrentOwnerPersonIds(unitId)` recipient resolution as
   * `onPaymentApproved`/`onPaymentRejected` above — no event payload
   * enrichment was needed, unlike Gamification's own `payerId` addition
   * (ADR-028), since a financial correction/reversal/refund is scoped to
   * the unit's ownership, not one specific reporter.
   */
  @OnEvent('AdjustmentCreated')
  async onAdjustmentCreated(event: AdjustmentCreatedEvent) {
    const ownerIds = await this.buildings.getCurrentOwnerPersonIds(event.unitId);
    const isDebtAdded = event.amount >= 0;
    await this.notifications.notifyMany(ownerIds, {
      buildingId: event.buildingId,
      category: 'FINANCIAL',
      priority: isDebtAdded ? 'HIGH' : 'NORMAL',
      title: isDebtAdded ? 'هزینه اصلاحی جدید' : 'اصلاح بدهی واحد',
      body: isDebtAdded
        ? 'یک هزینه اصلاحی به بدهی واحد شما اضافه شد.'
        : 'بخشی از بدهی واحد شما توسط مدیریت اصلاح شد.',
      referenceType: 'ADJUSTMENT',
      referenceId: event.adjustmentId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('PaymentReversed')
  async onPaymentReversed(event: PaymentReversedEvent) {
    const ownerIds = await this.buildings.getCurrentOwnerPersonIds(event.unitId);
    await this.notifications.notifyMany(ownerIds, {
      buildingId: event.buildingId,
      category: 'FINANCIAL',
      priority: 'HIGH',
      title: 'پرداخت لغو شد',
      body: 'پرداختی که قبلاً تأیید شده بود لغو شد و بدهی مربوطه دوباره باز شد.',
      referenceType: 'PAYMENT',
      referenceId: event.paymentId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('PaymentRefunded')
  async onPaymentRefunded(event: PaymentRefundedEvent) {
    const ownerIds = await this.buildings.getCurrentOwnerPersonIds(event.unitId);
    await this.notifications.notifyMany(ownerIds, {
      buildingId: event.buildingId,
      category: 'FINANCIAL',
      title: 'بازگشت وجه پرداخت',
      body: event.isFullRefund
        ? 'مبلغ پرداختی شما به طور کامل بازگردانده شد.'
        : 'بخشی از مبلغ پرداختی شما بازگردانده شد.',
      referenceType: 'PAYMENT',
      referenceId: event.paymentId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('VotePublished')
  async onVotePublished(event: VotePublishedEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'GOVERNANCE',
      title: 'رأی‌گیری جدید',
      body: 'یک رأی‌گیری جدید برای ساختمان شما فعال شد.',
      referenceType: 'VOTE',
      referenceId: event.voteId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('VoteClosed')
  async onVoteClosed(event: VoteClosedEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'GOVERNANCE',
      title: 'رأی‌گیری بسته شد',
      body: `نتیجه رأی‌گیری منتشر شد (${event.resultStatus}).`,
      referenceType: 'VOTE',
      referenceId: event.voteId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('VoteCancelled')
  async onVoteCancelled(event: VoteCancelledEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'GOVERNANCE',
      title: 'رأی‌گیری لغو شد',
      body: 'یک رأی‌گیری برای ساختمان شما لغو شد.',
      referenceType: 'VOTE',
      referenceId: event.voteId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('CaseCreated')
  async onCaseCreated(event: CaseCreatedEvent) {
    const recipientIds = await this.buildings.listCurrentMemberPersonIdsByRoles(event.buildingId, PRIVILEGED_ROLES);
    await this.notifications.notifyMany(recipientIds, {
      buildingId: event.buildingId,
      category: 'CASE',
      title: 'درخواست جدید نیاز به بررسی دارد',
      body: 'یک درخواست/شکایت/پیشنهاد جدید ثبت شد.',
      referenceType: 'CASE',
      referenceId: event.caseId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('CaseAssigned')
  async onCaseAssigned(event: CaseAssignedEvent) {
    await this.notifications.notify({
      recipientId: event.assignedToId,
      buildingId: event.buildingId,
      category: 'CASE',
      title: 'یک کیس به شما واگذار شد',
      body: 'یک درخواست/شکایت به شما اختصاص داده شد.',
      referenceType: 'CASE',
      referenceId: event.caseId,
      sourceEvent: event.eventName,
    });
  }

  /**
   * As of ADR-028 the payload also carries `actorPersonId` (added for
   * Gamification's XP attribution) — deliberately not used as the sole
   * recipient here, since the point of this notification is to inform
   * OTHER privileged members that a case's status changed, not to notify
   * the actor about their own action. Still broadcasts to all privileged
   * roles rather than the case's specific creator/assignee (that would
   * need CasesModule's repository, breaking the "notifications only
   * depend on BuildingModule" decoupling) — same honest MVP trade-off
   * documented for Documents' cross-module references in ADR-026 — see
   * ADR-027 Future Review.
   */
  @OnEvent('CaseStatusChanged')
  async onCaseStatusChanged(event: CaseStatusChangedEvent) {
    const recipientIds = await this.buildings.listCurrentMemberPersonIdsByRoles(event.buildingId, PRIVILEGED_ROLES);
    await this.notifications.notifyMany(recipientIds, {
      buildingId: event.buildingId,
      category: 'CASE',
      title: 'وضعیت کیس تغییر کرد',
      body: `وضعیت یک کیس از ${event.previousStatus} به ${event.newStatus} تغییر کرد.`,
      referenceType: 'CASE',
      referenceId: event.caseId,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('DocumentUploaded')
  async onDocumentUploaded(event: DocumentUploadedEvent) {
    const recipientIds = PRIVILEGED_DOCUMENT_CATEGORIES.includes(event.category)
      ? await this.buildings.listCurrentMemberPersonIdsByRoles(event.buildingId, PRIVILEGED_ROLES)
      : await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(recipientIds, {
      buildingId: event.buildingId,
      category: 'DOCUMENT',
      title: 'سند جدید بارگذاری شد',
      body: 'یک سند جدید برای ساختمان شما بارگذاری شد.',
      referenceType: 'DOCUMENT',
      referenceId: event.documentId,
      sourceEvent: event.eventName,
    });
  }

  /** LOW priority — an XP gain is a routine, frequent event, not one that should bypass a quiet-hours-minded user's preferences the way an Achievement/League change should. */
  @OnEvent('XpAwarded')
  async onXpAwarded(event: XpAwardedEvent) {
    await this.notifications.notify({
      recipientId: event.personId,
      buildingId: event.buildingId ?? undefined,
      category: 'GAMIFICATION',
      priority: 'LOW',
      title: 'امتیاز XP دریافت کردید',
      body: `شما ${event.amount} امتیاز XP دریافت کردید.`,
      referenceType: 'XP_REASON',
      referenceId: event.reason,
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('AchievementUnlocked')
  async onAchievementUnlocked(event: AchievementUnlockedEvent) {
    await this.notifications.notify({
      recipientId: event.personId,
      buildingId: event.buildingId ?? undefined,
      category: 'GAMIFICATION',
      title: 'دستاورد جدید باز شد!',
      body: `دستاورد «${event.title}» را باز کردید.`,
      referenceType: 'ACHIEVEMENT',
      referenceId: event.code,
      sourceEvent: event.eventName,
    });
  }

  /** Building-wide broadcast (same recipient-resolution shape as ChargeBatchIssued/VotePublished) — a league promotion/demotion is the whole building's result, not one person's. */
  @OnEvent('LeagueTierChanged')
  async onLeagueTierChanged(event: LeagueTierChangedEvent) {
    const memberIds = await this.buildings.listCurrentMemberPersonIds(event.buildingId);
    await this.notifications.notifyMany(memberIds, {
      buildingId: event.buildingId,
      category: 'GAMIFICATION',
      priority: 'HIGH',
      title: event.promoted ? 'ارتقای لیگ ساختمان' : 'تنزل لیگ ساختمان',
      body: event.promoted
        ? `ساختمان شما به لیگ ${event.newTier} ارتقا یافت.`
        : `ساختمان شما به لیگ ${event.newTier} تنزل یافت.`,
      referenceType: 'BUILDING',
      referenceId: event.buildingId,
      sourceEvent: event.eventName,
    });
  }
}
