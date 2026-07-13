import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';

@Injectable()
export class NotificationTemplateRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(params: {
    code: string;
    titleTemplate: string;
    bodyTemplate: string;
    isActive?: boolean;
  }) {
    return this.prisma.notificationTemplate.create({ data: params });
  }

  findById(id: string) {
    return this.prisma.notificationTemplate.findUnique({ where: { id } });
  }

  findByCode(code: string) {
    return this.prisma.notificationTemplate.findUnique({ where: { code } });
  }

  list(filters: { isActive?: boolean }) {
    return this.prisma.notificationTemplate.findMany({
      where: { isActive: filters.isActive },
      orderBy: { code: 'asc' },
    });
  }

  update(
    id: string,
    params: { titleTemplate?: string; bodyTemplate?: string; isActive?: boolean },
  ) {
    return this.prisma.notificationTemplate.update({ where: { id }, data: params });
  }
}
