import { FileInterceptor } from '@nestjs/platform-express';
import {
  boardMinutesMaxBytes,
  ManagerBoardMinutesService,
} from '../application/manager-board-minutes.service';
import {
  Controller,
  Get,
  Header,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ManagerVerificationService } from '../application/manager-verification.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 06.03 Rule 002 — Owner Approval Path. `approve` requires a current OWNER
 * role on the building (`RolesGuard`), same pattern as every other
 * OWNER-gated action. `appeal` is deliberately NOT role-gated — the
 * rejected candidate may no longer hold any current role on the building
 * by the time they appeal (07.02 Rule 012/013) — the creator/candidate
 * check happens inside `ManagerVerificationPolicy.assertCanAppeal`.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@Controller({ path: 'buildings/:id/manager-verification', version: '1' })
export class ManagerVerificationOwnerController {
  constructor(
    private readonly service: ManagerVerificationService,
    private readonly boardMinutes: ManagerBoardMinutesService,
  ) {}

  @Get('board-minutes')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MANAGER')
  boardMinutesStatus(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.boardMinutes.status(id, user.sub);
  }

  @Post('board-minutes')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MANAGER')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: boardMinutesMaxBytes, files: 1, fields: 0 },
    }),
  )
  submitBoardMinutes(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    return this.boardMinutes.submit(id, user.sub, requestId, file?.buffer);
  }

  @Post('approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER')
  approve(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.approveByOwner(id, user.sub, requestId);
  }

  @Post('appeal')
  @UseGuards(JwtAuthGuard)
  appeal(@Param('id') id: string, @CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    return this.service.appealCase(id, user.sub, requestId);
  }
}
