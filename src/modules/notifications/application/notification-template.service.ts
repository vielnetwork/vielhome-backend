import { Injectable } from '@nestjs/common';
import { NotificationTemplateRepository } from '../infrastructure/repositories/notification-template.repository';
import { NotificationPolicy } from '../domain/policies/notification.policy';
import { AuditService } from '../../../common/audit/audit.service';
import { DuplicateError, NotFoundAppError } from '../../../common/errors/app-error';
import { CreateNotificationTemplateDto } from './dto/create-notification-template.dto';
import { UpdateNotificationTemplateDto } from './dto/update-notification-template.dto';

/**
 * 21_ADRs > ADR-060 — a staff-managed library of `{{variable}}`-templated
 * notification copy (08.10 Rules 011/012), realizing
 * 13_Notification_Architecture's Frozen "No hardcoded user-visible text"
 * principle for future consumers. `render()` is the piece a future
 * `NotificationEventListener` rewiring would call; nothing calls it yet
 * this sprint — see ADR-060 Decision for the disclosed scope boundary.
 */
@Injectable()
export class NotificationTemplateService {
  constructor(
    private readonly templates: NotificationTemplateRepository,
    private readonly policy: NotificationPolicy,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateNotificationTemplateDto, actorId: string, requestId: string) {
    const existing = await this.templates.findByCode(dto.code);
    if (existing) {
      throw new DuplicateError(`A notification template with code "${dto.code}" already exists.`);
    }

    const template = await this.templates.create({
      code: dto.code,
      titleTemplate: dto.titleTemplate,
      bodyTemplate: dto.bodyTemplate,
      isActive: dto.isActive,
    });

    await this.audit.record({
      actorId,
      action: 'NotificationTemplateCreated',
      entityType: 'NotificationTemplate',
      entityId: template.id,
      requestId,
      metadata: { code: dto.code },
    });

    return template;
  }

  list(filters: { isActive?: boolean }) {
    return this.templates.list(filters);
  }

  async get(id: string) {
    const template = await this.templates.findById(id);
    if (!template) throw new NotFoundAppError('Notification template not found.');
    return template;
  }

  async update(id: string, dto: UpdateNotificationTemplateDto, actorId: string, requestId: string) {
    await this.get(id); // existence check — throws NotFoundAppError if missing

    const updated = await this.templates.update(id, {
      titleTemplate: dto.titleTemplate,
      bodyTemplate: dto.bodyTemplate,
      isActive: dto.isActive,
    });

    await this.audit.record({
      actorId,
      action: 'NotificationTemplateUpdated',
      entityType: 'NotificationTemplate',
      entityId: id,
      requestId,
      metadata: { fields: Object.keys(dto) },
    });

    return updated;
  }

  /**
   * The lookup-and-render entry point a future event-listener rewiring
   * would call. 08.10's own `TEMPLATE_NOT_FOUND` error code names exactly
   * this failure mode — surfaced here as `NotFoundAppError`, this
   * codebase's existing 404 type, rather than a new one-off error code.
   */
  async render(code: string, variables: Record<string, string>): Promise<{ title: string; body: string }> {
    const template = await this.templates.findByCode(code);
    if (!template || !template.isActive) {
      throw new NotFoundAppError(`No active notification template found for code "${code}".`);
    }
    return this.policy.renderTemplate(template, variables);
  }
}
