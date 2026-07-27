import { Injectable } from '@nestjs/common';
import { ProfileRepository, ProfileRecord } from '../infrastructure/repositories/profile.repository';
import { NotFoundAppError } from '../../../../common/errors/app-error';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class ProfileService {
  constructor(private readonly profiles: ProfileRepository) {}

  async getMyProfile(personId: string): Promise<ProfileRecord> {
    const person = await this.profiles.findById(personId);
    if (!person) {
      // Unreachable via any real, valid JWT (the token's `sub` always
      // names an existing Person) — defensive only, same "guard against
      // an impossible-in-practice state rather than assume" discipline
      // as the rest of this codebase's repositories/services.
      throw new NotFoundAppError('Person not found.');
    }
    return person;
  }

  async updateMyProfile(personId: string, dto: UpdateProfileDto): Promise<ProfileRecord> {
    // dto.firstName/dto.lastName are already trimmed and checked
    // non-empty by UpdateProfileDto's own @Transform + @IsNotEmpty (see
    // that file) — no further validation needed here.
    return this.profiles.updateName(personId, {
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
  }
}
