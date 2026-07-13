import { DomainEvent } from '../../../common/events/domain-event.base';

export class DocumentUploadedEvent extends DomainEvent {
  readonly eventName = 'DocumentUploaded';

  constructor(
    public readonly documentId: string,
    public readonly buildingId: string,
    public readonly createdById: string,
    public readonly category: string,
  ) {
    super();
  }
}

export class DocumentVersionCreatedEvent extends DomainEvent {
  readonly eventName = 'DocumentVersionCreated';

  constructor(
    public readonly documentId: string,
    public readonly buildingId: string,
    public readonly versionId: string,
    public readonly uploadedById: string,
  ) {
    super();
  }
}

export class DocumentArchivedEvent extends DomainEvent {
  readonly eventName = 'DocumentArchived';

  constructor(
    public readonly documentId: string,
    public readonly buildingId: string,
    public readonly actorId: string,
  ) {
    super();
  }
}

export class DocumentReferenceCreatedEvent extends DomainEvent {
  readonly eventName = 'DocumentReferenceCreated';

  constructor(
    public readonly documentId: string,
    public readonly buildingId: string,
    public readonly entityType: string,
    public readonly entityId: string,
  ) {
    super();
  }
}
