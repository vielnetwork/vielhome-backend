import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * PATCH /profile/me (Building Setup Refinement Phase 3B — Profile
 * Self-Edit). Deliberately just firstName/lastName — no `personId`/`phone`
 * field exists on this DTO at all, so `ValidationPipe`'s global
 * `forbidNonWhitelisted: true` (see main.ts) strips/rejects any attempt to
 * smuggle either into the body; identity comes exclusively from the
 * caller's JWT (`@CurrentUser()`), never the request body — see
 * `ProfileController`.
 *
 * No trim precedent exists elsewhere in this codebase's DTOs (e.g.
 * `RegisterTenantDto` only checks `@MinLength(1)`, which a single space
 * would satisfy). `@Transform` here trims BEFORE `@IsNotEmpty()`/
 * `@MaxLength()` run — `ValidationPipe`'s `transform: true` (main.ts) runs
 * class-transformer's `plainToInstance` first, applying `@Transform`,
 * before class-validator's decorators evaluate the result — so
 * whitespace-only input is correctly rejected as empty rather than
 * accepted as a 1+ character string.
 */
export class UpdateProfileDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;
}
