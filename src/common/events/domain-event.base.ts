/**
 * Base class for domain events (11_Backend_Architecture > Domain Events).
 * Events are immutable and named in past tense (BuildingCreated,
 * OwnershipTransferred, ...). Every important business action becomes one
 * of these; listeners react with Audit / Notification / Gamification /
 * Analytics side effects without coupling the domain to them
 * (Event Pipeline, 08_API_Architecture).
 */
export abstract class DomainEvent {
  abstract readonly eventName: string;
  readonly occurredAt: Date = new Date();
}
