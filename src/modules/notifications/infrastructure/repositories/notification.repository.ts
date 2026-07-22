import { Injectable } from '@nestjs/common';
import { NotificationCategory, NotificationChannel, NotificationPriority } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}
  /** Creates the Notification and one NotificationDelivery row per channel that passed the preference/priority gate in one write. */
  createNotification(params: {
    recipientId: string;
    buildingId?: string;
    category: NotificationCategory;
    priority: NotificationPriority;
    title: string;
    body: string;
    referenceType?: string;
    referenceId?: string;
    sourceEvent?: string;
    channels: NotificationChannel[];
  }) {
    return this.prisma.notification.create({
      data: {
        recipientId: params.recipientId,
        buildingId: params.buildingId,
        category: params.category,
        priority: params.priority,
        title: params.title,
        body: params.body,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        sourceEvent: params.sourceEvent,
        deliveries: { create: params.channels.map((channel) => ({ channel })) },
      },
      include: { deliveries: true },
    });
  }
  /**
   * 21_ADRs > ADR-077 round-3 — the exact same "un-awaited `EventEmitter2
   * .emit()` chain still in flight when a test's own cleanup deletes the
   * rows it's about to write to" race already found in `finance.e2e-spec
   * .ts`'s `BuildingScore` update (round 1) and `getOrCreatePreference`'s
   * upsert (round 2) also reaches here: `notify()` creates a
   * `NotificationDelivery` row and immediately marks it `SENT`, but if the
   * describe that triggered it has already moved on to its own `afterAll`
   * cleanup by the time this handler resumes, the row can be gone before
   * this `.update()` runs. Unlike the create-side races above, there's no
   * "re-read and return the winner's row" recovery here — the record is
   * gone, on purpose (test cleanup, not a real conflict), so there is
   * nothing left to mark. Treated as a safe no-op rather than re-thrown.
   */
  async markDeliverySent(deliveryId: string): Promise<void> {
    await this.updateDeliveryIfStillPresent(deliveryId, { status: 'SENT', sentAt: new Date() });
  }
  async markDeliveryFailed(deliveryId: string, reason: string): Promise<void> {
    await this.updateDeliveryIfStillPresent(deliveryId, {
      status: 'FAILED',
      failureReason: reason,
    });
  }
  private async updateDeliveryIfStillPresent(
    deliveryId: string,
    data: { status: 'SENT' | 'FAILED'; sentAt?: Date; failureReason?: string },
  ): Promise<void> {
    try {
      await this.prisma.notificationDelivery.update({ where: { id: deliveryId }, data });
    } catch (error) {
      const stillExists = await this.prisma.notificationDelivery.findUnique({
        where: { id: deliveryId },
      });
      if (!stillExists) return;
      throw error;
    }
  }
  /**
   * Used by `NotificationDispatchProcessor` (21_ADRs > ADR-039) — a
   * delivery row plus the parent Notification's own recipient/title,
   * everything the (still-available) log-stub dispatch needs. 21_ADRs >
   * ADR-088 extends the include to the recipient's own `email`/`phone`
   * (real Email/SMS dispatch) and non-revoked `devices` (real Push
   * dispatch needs each device's `pushToken`) — this one extra include is
   * cheaper than a second round-trip per delivery.
   */
  findDeliveryById(id: string) {
    return this.prisma.notificationDelivery.findUnique({
      where: { id },
      include: {
        notification: {
          include: {
            recipient: {
              include: { devices: { where: { revokedAt: null, pushToken: { not: null } } } },
            },
          },
        },
      },
    });
  }
  findById(id: string) {
    return this.prisma.notification.findUnique({ where: { id }, include: { deliveries: true } });
  }
  listForPerson(
    personId: string,
    filter?: { category?: NotificationCategory; unreadOnly?: boolean; includeArchived?: boolean },
  ) {
    return this.prisma.notification.findMany({
      where: {
        recipientId: personId,
        ...(filter?.category ? { category: filter.category } : {}),
        ...(filter?.unreadOnly ? { readAt: null } : {}),
        ...(filter?.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }
  searchForPerson(personId: string, params: { title?: string; category?: NotificationCategory }) {
    return this.prisma.notification.findMany({
      where: {
        recipientId: personId,
        archivedAt: null,
        ...(params.title ? { title: { contains: params.title, mode: 'insensitive' } } : {}),
        ...(params.category ? { category: params.category } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }
  countUnread(personId: string) {
    return this.prisma.notification.count({
      where: { recipientId: personId, readAt: null, archivedAt: null },
    });
  }
  markRead(id: string) {
    return this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  }
  markAllRead(personId: string) {
    return this.prisma.notification.updateMany({
      where: { recipientId: personId, readAt: null },
      data: { readAt: new Date() },
    });
  }
  archive(id: string) {
    return this.prisma.notification.update({ where: { id }, data: { archivedAt: new Date() } });
  }
  /**
   * One row per person, created lazily on first read/write — mirrors the
   * "no signup-time row" laziness already used for Finance's default Fund.
   *
   * 21_ADRs > ADR-070 — real toolchain run found this upsert can lose a
   * race when two domain events fire for the same brand-new person at
   * effectively the same time (the "welcome" SYSTEM notification from
   * `onPersonAuthenticated` and the registration XP bonus from
   * `onXpAwarded`, both gated on `isNewPerson`, both calling `notify()`
   * for the same `personId`). Not request-blocking — NestJS's own
   * event-listener wrapper catches and logs the failure — but the losing
   * caller's notification was silently never created.
   *
   * 21_ADRs > ADR-077 round-2 — the original fix here caught specifically
   * `P2002` (a clean unique-constraint violation) and re-read the winner's
   * row. The user's real toolchain then hit a *second*, differently-shaped
   * failure mode of this exact same race — once a growing e2e suite count
   * (this project's now-familiar "more suites, tighter timing" pattern,
   * already seen in `ADR-073`'s `RUN_ID` collision and `ADR-077`'s own
   * round-1 `BuildingScore` finding) made two concurrent `upsert()` calls
   * for the same brand-new `personId` interleave differently — Prisma's
   * own non-atomic check-then-act upsert plan surfaced a query-engine-
   * internal error ("Query interpretation error ... Expected a valid
   * parent ID to be present for create follow-up for upsert query")
   * instead of the clean `P2002` the first fix assumed was the only
   * shape this race could take. Both are the same underlying condition —
   * someone else's concurrent call already created this `personId`'s row
   * — so this no longer special-cases on Prisma's error code at all.
   *
   * 21_ADRs > ADR-077 round-3 — a single immediate re-read still wasn't
   * always enough: with registration now firing three concurrent
   * `notify()` calls for the same brand-new person (`onPersonAuthenticated`
   * , `onXpAwarded`, and — once that XP unlocks `FIRST_STEPS` —
   * `onAchievementUnlocked`), the caller whose own `upsert()` lost the
   * race can still read a moment *before* whichever of the other two
   * actually wins commits its row, so `findUnique` can legitimately find
   * nothing yet even though this is the same benign race. Reused this
   * file's own `waitFor`-style short-retry idiom (already established in
   * every Testing-phase e2e file for this exact class of async-timing
   * gap) instead of a single-shot re-read.
   */
  async getOrCreatePreference(personId: string) {
    try {
      return await this.prisma.notificationPreference.upsert({
        where: { personId },
        update: {},
        create: { personId },
      });
    } catch (error) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const existing = await this.prisma.notificationPreference.findUnique({
          where: { personId },
        });
        if (existing) return existing;
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw error;
    }
  }
  /**
   * 21_ADRs > ADR-088 — registers/refreshes the FCM registration token for
   * one of the caller's own devices (`PATCH /notifications/push-token`).
   * `updateMany` with `personId` in the `where` (rather than `update` by
   * `deviceToken` alone) means a device that exists but belongs to a
   * DIFFERENT person updates zero rows instead of succeeding — the caller
   * can't overwrite another account's push target even if they somehow
   * knew that device's `deviceToken`. Returns whether a row was actually
   * updated so the service layer can 404 on a genuine "not found," without
   * this repository method leaking which specific reason (wrong owner vs.
   * truly nonexistent vs. revoked) caused the zero-count — same
   * ownership-hiding posture `DocumentPolicy`/`CasePolicy` already use
   * elsewhere in this codebase.
   */
  async updateDevicePushToken(
    personId: string,
    deviceToken: string,
    pushToken: string,
  ): Promise<boolean> {
    const result = await this.prisma.device.updateMany({
      where: { deviceToken, personId, revokedAt: null },
      data: { pushToken, lastSeenAt: new Date() },
    });
    return result.count > 0;
  }
  updatePreference(
    personId: string,
    data: Partial<{
      inAppEnabled: boolean;
      pushEnabled: boolean;
      emailEnabled: boolean;
      smsEnabled: boolean;
      marketingEnabled: boolean;
    }>,
  ) {
    return this.prisma.notificationPreference.upsert({
      where: { personId },
      update: data,
      create: { personId, ...data },
    });
  }
}
