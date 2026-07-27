import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../../common/prisma/prisma.service';

export interface ProfileRecord {
  id: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
}

const PROFILE_SELECT = { id: true, phone: true, firstName: true, lastName: true } as const;

@Injectable()
export class ProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(personId: string): Promise<ProfileRecord | null> {
    return this.prisma.person.findUnique({
      where: { id: personId },
      select: PROFILE_SELECT,
    });
  }

  /**
   * Writes ONLY `firstName`/`lastName` — never `fullName` (deprecated;
   * see `schema.prisma`'s own comment on `Person.fullName`, added in
   * Building Setup Refinement Phase 3: "no code writes this going
   * forward").
   */
  async updateName(
    personId: string,
    data: { firstName: string; lastName: string },
  ): Promise<ProfileRecord> {
    return this.prisma.person.update({
      where: { id: personId },
      data: { firstName: data.firstName, lastName: data.lastName },
      select: PROFILE_SELECT,
    });
  }
}
