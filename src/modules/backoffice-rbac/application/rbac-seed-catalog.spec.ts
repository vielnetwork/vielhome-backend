import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('canonical RBAC seed advertising permissions', () => {
  const source = readFileSync(join(process.cwd(), 'prisma/seed/rbac.seed.ts'), 'utf8');

  it.each(['ADVERTISING_VIEW', 'ADVERTISING_MANAGE'])('contains %s exactly once', (key) => {
    const catalog = source.slice(
      source.indexOf('const PERMISSIONS'),
      source.indexOf('const ROLE_PERMISSION_MATRIX'),
    );
    expect(catalog.match(new RegExp(`key: '${key}'`, 'g'))).toHaveLength(1);
  });

  it('grants Super Admin the canonical catalog without an advertising special case', () => {
    expect(source).toContain("'Super Admin': PERMISSIONS.map((p) => p.key)");
    const matrix = source.slice(source.indexOf('const ROLE_PERMISSION_MATRIX'));
    expect(matrix).not.toMatch(/'Super Admin'[\s\S]{0,300}ADVERTISING_(VIEW|MANAGE)/);
  });

  it('remains convergent and never seeds a real StaffRole grant', () => {
    expect(source).toContain('prisma.permission.findUnique');
    expect(source).toContain('prisma.rolePermission.findFirst');
    expect(source).not.toContain('prisma.staffRole.create');
  });
});
