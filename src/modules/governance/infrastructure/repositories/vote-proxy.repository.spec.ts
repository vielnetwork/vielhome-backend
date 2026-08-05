import { Prisma } from '@prisma/client';
import { VoteProxyRepository } from './vote-proxy.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * Governance Hardening Phase 1 — `VoteProxyRepository.grant()` regression
 * coverage for the concurrent-grant race fixed per the Governance audit's
 * §31 finding: two overlapping `grant()` calls for the same unit could
 * previously both leave an `isCurrent: true` row for that unit, silently
 * violating "at most one current proxy per unit."
 *
 * `$transaction` is mocked directly — this exercises `grant()`'s own
 * Serializable-then-retry-once orchestration in isolation, not Postgres's
 * actual conflict detection (which needs a real database and is exercised
 * instead by `test/governance.e2e-spec.ts`'s "Standing Proxy Voting"
 * describe against the real `grant` endpoint).
 */
describe('VoteProxyRepository', () => {
  let transactionMock: jest.Mock;
  let repository: VoteProxyRepository;

  const GRANT_PARAMS = {
    unitId: 'unit-1',
    buildingId: 'b1',
    granterPersonId: 'person-1',
    proxyPersonId: 'person-2',
  };
  const CREATED_PROXY = { id: 'proxy-1', ...GRANT_PARAMS, isCurrent: true };

  function makeP2034(): Prisma.PrismaClientKnownRequestError {
    const conflictError = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
    conflictError.code = 'P2034';
    return conflictError;
  }

  beforeEach(() => {
    transactionMock = jest.fn();
    repository = new VoteProxyRepository({
      $transaction: transactionMock,
    } as unknown as PrismaService);
  });

  describe('grant', () => {
    it('returns the created proxy on the first attempt, run at Serializable isolation, when there is no conflict', async () => {
      transactionMock.mockResolvedValueOnce(CREATED_PROXY);

      const result = await repository.grant(GRANT_PARAMS);

      expect(result).toBe(CREATED_PROXY);
      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    });

    it('retries once and succeeds when the Serializable transaction hits a P2034 write conflict', async () => {
      transactionMock.mockRejectedValueOnce(makeP2034()).mockResolvedValueOnce(CREATED_PROXY);

      const result = await repository.grant(GRANT_PARAMS);

      expect(result).toBe(CREATED_PROXY);
      expect(transactionMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry and propagates a non-P2034 error unchanged', async () => {
      const otherError = new Error('connection lost');
      transactionMock.mockRejectedValueOnce(otherError);

      await expect(repository.grant(GRANT_PARAMS)).rejects.toBe(otherError);
      expect(transactionMock).toHaveBeenCalledTimes(1);
    });

    it('propagates a second consecutive P2034 conflict rather than retrying indefinitely', async () => {
      const conflictError = makeP2034();
      transactionMock.mockRejectedValue(conflictError);

      await expect(repository.grant(GRANT_PARAMS)).rejects.toBe(conflictError);
      expect(transactionMock).toHaveBeenCalledTimes(2);
    });
  });
});
