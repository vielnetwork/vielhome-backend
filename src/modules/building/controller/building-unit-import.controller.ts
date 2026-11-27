import {
  Body, Controller, Get, Header, Param, Post, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { ValidationError } from '../../../common/errors/app-error';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { BuildingUnitImportService } from '../application/building-unit-import.service';
import { unitWorkbookLimit } from '../application/unit-import-workbook';

const WorkbookUpload = FileInterceptor('file', {
  limits: { fileSize: unitWorkbookLimit, files: 1, fields: 1, fieldSize: 128 },
});

@Controller({ path: 'buildings/:id/units/import', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class BuildingUnitImportController {
  constructor(private readonly imports: BuildingUnitImportService) {}

  @Get('template')
  @Header('Cache-Control', 'no-store')
  @Roles('MANAGER')
  template(@Param('id') buildingId: string) {
    return this.imports.template(buildingId);
  }

  @Post('preview')
  @Roles('MANAGER')
  @UseInterceptors(WorkbookUpload)
  preview(@Param('id') buildingId: string, @UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new ValidationError('INVALID_UNIT_WORKBOOK');
    return this.imports.preview(buildingId, file.buffer);
  }

  @Post('apply')
  @Roles('MANAGER')
  @UseInterceptors(WorkbookUpload)
  apply(
    @Param('id') buildingId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
    @Body('revision') revision: string,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    if (!file || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new ValidationError('INVALID_UNIT_WORKBOOK');
    }
    return this.imports.apply(buildingId, user.sub, requestId, file.buffer, revision);
  }
}
