import { Body, Controller, Headers, Post } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthorizationError } from '../../../common/errors/app-error';
import { normalizeIranianMobilePhone } from '../../../common/phone/phone.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { OwnerRbacService } from '../application/owner-rbac.service';
import { RbacManagementService } from '../application/rbac-management.service';

@Controller({ path: 'backoffice/owner/roles', version: '1' })
export class OwnerRbacController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerRoles: OwnerRbacService,
    private readonly roles: RbacManagementService,
  ) {}

  @Post()
  async manage(@Headers('x-vh-owner-signature') signature: string | undefined, @Body('payload') body: unknown) {
    const secret = process.env.BACKOFFICE_OWNER_ROLE_BRIDGE_SECRET;
    const actorPhone = normalizeIranianMobilePhone(process.env.BACKOFFICE_OWNER_ACTOR_PHONE);
    if (!secret || secret.length < 32 || !actorPhone || !signature || typeof body !== 'string') {
      throw new AuthorizationError('Owner role access denied.');
    }
    const expected = createHmac('sha256', secret).update(body).digest();
    const provided = Buffer.from(signature, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AuthorizationError('Owner role access denied.');
    }
    const { nonce, expires, subject, action, phone, id } = JSON.parse(body);
    const now = Date.now();
    if (typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce) ||
        !Number.isSafeInteger(expires) || expires <= now || expires > now + 30_000 ||
        typeof subject !== 'string' || !subject ||
        !['catalog', 'list', 'assign', 'revoke', 'invite'].includes(action) ||
        (action !== 'catalog' && typeof phone !== 'string') ||
        (['assign', 'revoke', 'invite'].includes(action) && (typeof id !== 'string' || !id))) {
      throw new AuthorizationError('Owner role access denied.');
    }
    const owner = await this.prisma.backofficeOwnerPasskey.findUnique({
      where: { ownerKey: 'platform-owner' },
      select: { googleSubject: true },
    });
    if (owner?.googleSubject !== subject) throw new AuthorizationError('Owner role access denied.');

    const actor = await this.prisma.person.findUnique({
      where: { phone: actorPhone },
      select: { id: true },
    });
    if (!actor) throw new AuthorizationError('The configured owner audit account does not exist.');
    const actorId = actor.id;

    const claimed = await this.prisma.backofficeOwnerRoleRequest.createMany({
      data: [{ id: nonce, expiresAt: new Date(expires) }],
      skipDuplicates: true,
    });
    if (claimed.count !== 1) throw new AuthorizationError('Owner role request already used.');
    await this.prisma.backofficeOwnerRoleRequest.deleteMany({
      where: { expiresAt: { lte: new Date(now) } },
    });

    switch (action) {
      case 'catalog': return this.roles.listRoles();
      case 'list': return this.ownerRoles.listForPhone(phone);
      case 'invite': return this.ownerRoles.invite(phone, id, actorId);
      case 'assign': return this.ownerRoles.assign(phone, id, actorId, nonce);
      case 'revoke': return this.ownerRoles.revoke(phone, id, actorId, nonce);
    }
  }
}
