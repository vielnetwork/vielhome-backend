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

  markDeliverySent(deliveryId: string) {
    return this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'SENT', sentAt: new Date() },
    });
  }

  markDeliveryFailed(deliveryId: string, reason: string) {
    return this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'FAILED', failureReason: reason },
    });
  }

  /** Used by `NotificationDispatchProcessor` (21_ADRs > ADR-039) — a delivery row plus the parent Notification's own recipient/title, everything the stub dispatch needs to log a message and decide whether it's still PENDING. */
  findDeliveryById(id: string) {
    return this.prisma.notificationDelivery.findUnique({
      where: { id },
      include: { notification: true },
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
   * — so this no longer special-cases on Prisma's error code at all: any
   * failure here re-reads directly, and only re-throws if the row
   * genuinely still doesn't exist (a real, different error).
   */
  async getOrCreatePreference(personId: string) {
    try {
      return await this.prisma.notificationPreference.upsert({
        where: { personId },
        update: {},
        create: { personId },
      });
    } catch (error) {
      const existing = await this.prisma.notificationPreference.findUnique({
        where: { personId },
      });
      if (existing) return existing;
      throw error;
    }
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
