import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * Governance Hardening Phase 1 (audit §31) — a P2034 write-conflict/
 * serialization-failure raised by `grant()`'s own `Serializable`
 * transaction below signals exactly the concurrent-grant race that
 * transaction exists to prevent; see `grant()`'s own comment for why a
 * single retry is the correct response, not a client-facing error.
 */
function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

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
   * DB-level partial unique index (Prisma doesn't support one) — see
   * `VoteProxy`'s own schema comment.
   *
   * Governance Hardening Phase 1 (audit §31) — this transaction alone,
   * under Postgres's default READ COMMITTED isolation, was NOT actually
   * sufficient to guarantee "at most one current proxy per unit": two
   * overlapping `grant()` calls for the same unit could each have their
   * `updateMany` block on the other's row lock, then — once unblocked —
   * see zero rows left to end, and *both* would still unconditionally
   * `create` their own `isCurrent: true` row, leaving two "current"
   * proxies for one unit. Running the transaction at `Serializable`
   * isolation instead makes Postgres genuinely detect this conflict and
   * abort the loser with a `P2034` write-conflict error rather than
   * letting it silently commit; retrying once resolves cleanly, since by
   * the time the retry's transaction starts, the winner has already
   * committed and the retry's own `updateMany` correctly sees (and ends)
   * it. A second consecutive conflict (vanishingly unlikely with only two
   * concurrent callers) propagates rather than retrying indefinitely.
   */
  async grant(params: {
    unitId: string;
    buildingId: string;
    granterPersonId: string;
    proxyPersonId: string;
  }) {
    const attempt = () =>
      this.prisma.$transaction(
        async (tx) => {
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

    try {
      return await attempt();
    } catch (error) {
      if (isSerializationFailure(error)) {
        return attempt();
      }
      throw error;
    }
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
