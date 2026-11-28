import { IsBoolean, IsString, Length } from 'class-validator';

export class FirstChargeVoteDto {
  @IsString()
  @Length(1, 64)
  pollId!: string;

  @IsString()
  @Length(1, 64)
  unitId!: string;

  @IsBoolean()
  approved!: boolean;
}
