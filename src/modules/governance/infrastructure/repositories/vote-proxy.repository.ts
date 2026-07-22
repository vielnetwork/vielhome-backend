import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';

@Injectable()
export class VoteProxyRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrentForUnit(unitId: string) {
    return this.prisma.voteProxy.findFirst({ where: { unitId, isCurrent: true } });
  }

  findById(id: string) {
    return this.prisma.voteProxy.findUnique({ where: { id } });
  }

  /**
   * Ends any existing current proxy for this unit and creates the new one
   * in the same transaction — same ended-and-recreated-on-change pattern
   * `BuildingRepository.changeManager` uses for manager succession. No
   * DB-level partial unique index (Prisma doesn't support one) — this
   * transaction IS the enforcement of "at most one current proxy per
   * unit" (see `VoteProxy`'s own schema comment).
   */
  grant(params: {
    unitId: string;
    buildingId: string;
    granterPersonId: string;
    proxyPersonId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.voteProxy.updateMany({
        where: { unitId: params.unitId, isCurrent: true },
        data: { isCurrent: false, revokedAt: new Date() },
      });
      return tx.voteProxy.create({
        data: {
          unitId: params.unitId,
          buildingId: params.buildingId,
          granterPersonId: params.granterPersonId,
          proxyPersonId: params.proxyPersonId,
        },
      });
    });
  }

  revoke(id: string) {
    return this.prisma.voteProxy.update({
      where: { id },
      data: { isCurrent: false, revokedAt: new Date() },
    });
  }

  /**
   * `VotingService.castBallot`'s proxy check — is `proxyPersonId`
   * currently standing in for `granterPersonId`, live, right now (checked
   * at cast-time, not frozen into the eligibility snapshot — see
   * `VoteProxy`'s own schema comment on the disclosed "self-healing"
   * property this gives).
   */
  async isCurrentProxyFor(granterPersonId: string, proxyPersonId: string): Promise<boolean> {
    const count = await this.prisma.voteProxy.count({
      where: { granterPersonId, proxyPersonId, isCurrent: true },
    });
    return count > 0;
  }
}
