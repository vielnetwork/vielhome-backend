import { DocumentPolicy } from './document.policy';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  ValidationError,
} from '../../../../common/errors/app-error';

describe('DocumentPolicy', () => {
  let policy: DocumentPolicy;

  beforeEach(() => {
    policy = new DocumentPolicy();
  });

  describe('assertFileTypeSupported', () => {
    it('allows PDF/JPG/JPEG/PNG (case-insensitive)', () => {
      expect(() => policy.assertFileTypeSupported('PDF')).not.toThrow();
      expect(() => policy.assertFileTypeSupported('jpg')).not.toThrow();
      expect(() => policy.assertFileTypeSupported('jpeg')).not.toThrow();
      expect(() => policy.assertFileTypeSupported('png')).not.toThrow();
    });

    it('rejects an unsupported file type', () => {
      expect(() => policy.assertFileTypeSupported('EXE')).toThrow(ValidationError);
      expect(() => policy.assertFileTypeSupported('docx')).toThrow(ValidationError);
    });
  });

  describe('assertFileSizeWithinLimit', () => {
    it('allows a file at or under the 25MB ceiling', () => {
      expect(() => policy.assertFileSizeWithinLimit(1)).not.toThrow();
      expect(() => policy.assertFileSizeWithinLimit(25 * 1024 * 1024)).not.toThrow();
    });

    it('rejects a file over the 25MB ceiling', () => {
      expect(() => policy.assertFileSizeWithinLimit(25 * 1024 * 1024 + 1)).toThrow(ValidationError);
    });
  });

  describe('assertCategoryManageable', () => {
    it('allows any member to manage MAINTENANCE/GENERAL', () => {
      expect(() => policy.assertCategoryManageable('MAINTENANCE', false)).not.toThrow();
      expect(() => policy.assertCategoryManageable('GENERAL', false)).not.toThrow();
    });

    it('requires a privileged role for GOVERNANCE/FINANCIAL/LEGAL', () => {
      expect(() => policy.assertCategoryManageable('GOVERNANCE', false)).toThrow(
        AuthorizationError,
      );
      expect(() => policy.assertCategoryManageable('FINANCIAL', false)).toThrow(AuthorizationError);
      expect(() => policy.assertCategoryManageable('LEGAL', false)).toThrow(AuthorizationError);
    });

    it('allows a privileged role to manage any category', () => {
      expect(() => policy.assertCategoryManageable('GOVERNANCE', true)).not.toThrow();
      expect(() => policy.assertCategoryManageable('FINANCIAL', true)).not.toThrow();
    });
  });

  describe('assertVisible', () => {
    it('allows any member to view PUBLIC/MEMBERS_ONLY', () => {
      expect(() => policy.assertVisible('PUBLIC', false)).not.toThrow();
      expect(() => policy.assertVisible('MEMBERS_ONLY', false)).not.toThrow();
    });

    it('restricts MANAGEMENT_ONLY to privileged roles', () => {
      expect(() => policy.assertVisible('MANAGEMENT_ONLY', false)).toThrow(AuthorizationError);
      expect(() => policy.assertVisible('MANAGEMENT_ONLY', true)).not.toThrow();
    });
  });

  describe('assertNotArchived', () => {
    it('throws for an archived document', () => {
      expect(() => policy.assertNotArchived('ARCHIVED')).toThrow(BusinessRuleViolationError);
    });

    it('allows an active document', () => {
      expect(() => policy.assertNotArchived('ACTIVE')).not.toThrow();
    });
  });

  describe('assertArchivable', () => {
    it('throws if already archived', () => {
      expect(() => policy.assertArchivable('ARCHIVED')).toThrow(BusinessRuleViolationError);
    });

    it('allows archiving an active document', () => {
      expect(() => policy.assertArchivable('ACTIVE')).not.toThrow();
    });
  });
});
