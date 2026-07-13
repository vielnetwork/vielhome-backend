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

  /** One row per person, created lazily on first read/write — mirrors the "no signup-time row" laziness already used for Finance's default Fund. */
  getOrCreatePreference(personId: string) {
    return this.prisma.notificationPreference.upsert({
      where: { personId },
      update: {},
      create: { personId },
    });
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
