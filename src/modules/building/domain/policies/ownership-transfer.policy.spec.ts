import { OwnershipTransferPolicy } from './ownership-transfer.policy';
import { AuthorizationError } from '../../../../common/errors/app-error';

describe('OwnershipTransferPolicy', () => {
  const policy = new OwnershipTransferPolicy();

  describe('assertCallerIsCurrentOwner', () => {
    it('allows the current owner to initiate a transfer', () => {
      expect(() => policy.assertCallerIsCurrentOwner(true)).not.toThrow();
    });

    it('refuses anyone who is not the current owner', () => {
      expect(() => policy.assertCallerIsCurrentOwner(false)).toThrow(AuthorizationError);
    });
  });
});
