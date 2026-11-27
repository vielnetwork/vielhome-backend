import { Body, Controller, Get, Header, Post, Query, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthorizationError, ConflictError, ValidationError } from '../../../common/errors/app-error';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { generalTerms, managerTerms } from '../application/legal-documents';

@Controller({ path: 'legal', version: '1' })
@UseGuards(JwtAuthGuard)
export class LegalAcceptanceController {
  constructor(private readonly prisma: PrismaService) {}

  private async document(personId: string, buildingId?: string) {
    if (buildingId !== undefined && (typeof buildingId !== 'string' || !buildingId.trim())) {
      throw new ValidationError('Invalid building identifier.');
    }
    const manager = buildingId ? await this.prisma.membership.findFirst({
      where: { personId, buildingId, role: 'MANAGER', isCurrent: true },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, startedAt: true, building: { select: { name: true } } },
    }) : null;
    if (buildingId && !manager) return null;
    const terms = manager ? managerTerms : generalTerms;
    return {
      ...terms,
      scope: manager ? manager.id : 'general',
      version: createHash('sha256').update(JSON.stringify(terms)).digest('hex'),
      buildingId: buildingId ?? null,
      buildingName: manager?.building.name ?? null,
      managerStartedAt: manager?.startedAt ?? null,
    };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async current(@CurrentUser() user: JwtPayload, @Query('buildingId') buildingId?: string) {
    const doc = await this.document(user.sub, buildingId);
    if (!doc) return { required: false };
    const accepted = await this.prisma.legalAcceptance.findUnique({
      where: { personId_scope_version: { personId: user.sub, scope: doc.scope, version: doc.version } },
      select: { acceptedAt: true },
    });
    return { ...doc, required: !accepted };
  }

  @Post()
  async accept(
    @CurrentUser() user: JwtPayload,
    @Body('buildingId') buildingId: string | undefined,
    @Body('scope') scope: string,
    @Body('version') version: string,
  ) {
    const doc = await this.document(user.sub, buildingId);
    if (!doc) throw new AuthorizationError('This management term is unavailable.');
    if (doc.scope !== scope || doc.version !== version) {
      throw new ConflictError('The document or management term changed.');
    }
    const key = { personId: user.sub, scope, version };
    return this.prisma.legalAcceptance.upsert({
      where: { personId_scope_version: key },
      update: {},
      create: {
        ...key, buildingId: doc.buildingId, buildingName: doc.buildingName,
        managerStartedAt: doc.managerStartedAt,
        title: doc.title, text: doc.text,
      },
      select: { acceptedAt: true },
    });
  }

  @Get('accepted')
  @Header('Cache-Control', 'no-store')
  history(@CurrentUser() user: JwtPayload) {
    return this.prisma.legalAcceptance.findMany({
      where: { personId: user.sub },
      orderBy: { acceptedAt: 'desc' },
    });
  }
}
