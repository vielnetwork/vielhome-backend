import { UnitVisibilityPolicy, type UnitPrivacyContext } from './unit-visibility.policy';
import { AuthorizationError } from '../../../../common/errors/app-error';

// Building Access Refinement Phase 4 (Privacy / Data Visibility). Pure
// unit tests for the centralized redaction/gating policy — no Prisma, no
// NestJS testing module, same "plain `new Policy()`" shape every sibling
// `*.policy.spec.ts` in this directory already uses.
describe('UnitVisibilityPolicy', () => {
  const policy = new UnitVisibilityPolicy();

  const baseUnit = {
    id: 'unit-1',
    buildingId: 'building-1',
    unitNumber: '101',
    floorNumber: 1,
    areaSqm: 80,
    occupancyStatus: 'TENANT_OCCUPIED',
    ownerFullName: 'Pending Owner',
    ownerFirstName: 'Pending',
    ownerLastName: 'Owner',
    ownerPhone: '+989120000001',
    ownerInviteSentAt: new Date('2026-01-01'),
  };

  const owner = { personId: 'owner-1', firstName: 'Sara', lastName: 'Ahmadi', phone: '+989120000002' };
  const tenant = { personId: 'tenant-1', firstName: 'Reza', lastName: 'Karimi', phone: '+989120000003' };

  const ctx = (overrides: Partial<UnitPrivacyContext> = {}): UnitPrivacyContext => ({
    isManager: false,
    isCurrentOwnerOfUnit: false,
    isCurrentTenantOfUnit: false,
    isInvitedOwnerCandidate: false,
    ...overrides,
  });

  describe('shapeUnit — pending owner-invite fields', () => {
    it('keeps pending owner fields for MANAGER', () => {
      const shaped: Record<string, unknown> = policy.shapeUnit(baseUnit, ctx({ isManager: true }), null, null);
      expect(shaped.ownerFullName).toBe('Pending Owner');
      expect(shaped.ownerPhone).toBe('+989120000001');
    });

    it('keeps pending owner fields for the unit’s own current Owner', () => {
      const shaped: Record<string, unknown> = policy.shapeUnit(baseUnit, ctx({ isCurrentOwnerOfUnit: true }), owner, null);
      expect(shaped.ownerFullName).toBe('Pending Owner');
    });

    it('keeps pending owner fields for the exact invited-unclaimed candidate', () => {
      const shaped: Record<string, unknown> = policy.shapeUnit(baseUnit, ctx({ isInvitedOwnerCandidate: true }), null, null);
      expect(shaped.ownerPhone).toBe('+989120000001');
    });

    it('strips every pending owner field for the unit’s own current Tenant', () => {
      const shaped: Record<string, unknown> = policy.shapeUnit(
        baseUnit,
        ctx({ isCurrentTenantOfUnit: true }),
        owner,
        null,
      );
      expect(shaped.ownerFullName).toBeUndefined();
      expect(shaped.ownerFirstName).toBeUndefined();
      expect(shaped.ownerLastName).toBeUndefined();
      expect(shaped.ownerPhone).toBeUndefined();
      expect(shaped.ownerInviteSentAt).toBeUndefined();
    });

    it('strips every pending owner field for an unrelated building member', () => {
      const shaped: Record<string, unknown> = policy.shapeUnit(baseUnit, ctx(), null, null);
      expect(shaped.ownerFullName).toBeUndefined();
      expect(shaped.ownerFirstName).toBeUndefined();
      expect(shaped.ownerLastName).toBeUndefined();
      expect(shaped.ownerPhone).toBeUndefined();
      expect(shaped.ownerInviteSentAt).toBeUndefined();
    });

    it('never mutates the original unit object', () => {
      const original = { ...baseUnit };
      policy.shapeUnit(baseUnit, ctx(), null, null);
      expect(baseUnit).toEqual(original);
    });
  });

  describe('shapeUnit — currentOwner/currentTenant summaries', () => {
    it('MANAGER sees both summaries', () => {
      const shaped = policy.shapeUnit(baseUnit, ctx({ isManager: true }), owner, tenant);
      expect(shaped.currentOwner).toEqual(owner);
      expect(shaped.currentTenant).toEqual(tenant);
    });

    it('the unit’s own current Owner sees both their own identity and their tenant’s', () => {
      const shaped = policy.shapeUnit(baseUnit, ctx({ isCurrentOwnerOfUnit: true }), owner, tenant);
      expect(shaped.currentOwner).toEqual(owner);
      expect(shaped.currentTenant).toEqual(tenant);
    });

    it('the unit’s own current Tenant sees the current owner’s identity (Phase 4 decision) and their own', () => {
      const shaped = policy.shapeUnit(baseUnit, ctx({ isCurrentTenantOfUnit: true }), owner, tenant);
      expect(shaped.currentOwner).toEqual(owner);
      expect(shaped.currentTenant).toEqual(tenant);
    });

    it('an unrelated building member sees neither summary, even though they exist', () => {
      const shaped = policy.shapeUnit(baseUnit, ctx(), owner, tenant);
      expect(shaped.currentOwner).toBeNull();
      expect(shaped.currentTenant).toBeNull();
    });

    it('an invited-unclaimed candidate (not yet a member) sees neither summary', () => {
      const shaped = policy.shapeUnit(baseUnit, ctx({ isInvitedOwnerCandidate: true }), owner, tenant);
      expect(shaped.currentOwner).toBeNull();
      expect(shaped.currentTenant).toBeNull();
    });
  });

  describe('assertCanAccessUnitHistory', () => {
    it('allows MANAGER', () => {
      expect(() => policy.assertCanAccessUnitHistory(ctx({ isManager: true }))).not.toThrow();
    });

    it('allows the unit’s own current Owner', () => {
      expect(() => policy.assertCanAccessUnitHistory(ctx({ isCurrentOwnerOfUnit: true }))).not.toThrow();
    });

    it('allows the unit’s own current Tenant', () => {
      expect(() => policy.assertCanAccessUnitHistory(ctx({ isCurrentTenantOfUnit: true }))).not.toThrow();
    });

    it('denies an unrelated building member (BOARD_MEMBER/ACCOUNTANT/other-unit OWNER or TENANT)', () => {
      expect(() => policy.assertCanAccessUnitHistory(ctx())).toThrow(AuthorizationError);
    });

    it('denies an invited-unclaimed candidate — eligibility to claim is not eligibility to read history', () => {
      expect(() => policy.assertCanAccessUnitHistory(ctx({ isInvitedOwnerCandidate: true }))).toThrow(
        AuthorizationError,
      );
    });
  });

  describe('shapeHistoryEntry', () => {
    const entry = {
      id: 'ownership-1',
      unitId: 'unit-1',
      personId: 'previous-owner-1',
      startDate: new Date('2024-01-01'),
      endDate: new Date('2025-01-01'),
      isCurrent: false,
      person: { id: 'previous-owner-1', fullName: 'Previous Owner', phone: '+989120000009' },
    };

    it('MANAGER sees full identity on every row', () => {
      const shaped = policy.shapeHistoryEntry(entry, ctx({ isManager: true }), 'someone-else');
      expect(shaped.personId).toBe('previous-owner-1');
      expect(shaped.person).toEqual(entry.person);
    });

    it('the caller sees full identity on their OWN row', () => {
      const shaped = policy.shapeHistoryEntry(entry, ctx({ isCurrentOwnerOfUnit: true }), 'previous-owner-1');
      expect(shaped.personId).toBe('previous-owner-1');
      expect(shaped.person).toEqual(entry.person);
    });

    it('a non-manager caller viewing SOMEONE ELSE’S row gets identity redacted but keeps dates/status', () => {
      const shaped = policy.shapeHistoryEntry(entry, ctx({ isCurrentOwnerOfUnit: true }), 'current-owner-1');
      expect(shaped.personId).toBeNull();
      expect(shaped.person).toBeNull();
      expect(shaped.startDate).toEqual(entry.startDate);
      expect(shaped.endDate).toEqual(entry.endDate);
      expect(shaped.isCurrent).toBe(false);
    });

    it('never mutates the original entry object', () => {
      const original = { ...entry, person: { ...entry.person } };
      policy.shapeHistoryEntry(entry, ctx({ isCurrentOwnerOfUnit: true }), 'current-owner-1');
      expect(entry).toEqual(original);
    });
  });
});
