import { EntityManager } from 'typeorm';
import { IntegrationEvent } from '../domain/events';
import { OutboxRecord } from '../infrastructure/records';

export async function enqueueEvent<T>(manager: EntityManager, event: IntegrationEvent<T>): Promise<void> {
  await manager.insert(OutboxRecord, {
    id: event.eventId,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.toJSON(),
    occurredAt: event.occurredAt,
    attempts: 0, nextAttemptAt: null, publishedAt: null, lockedUntil: null, lockOwner: null,
  });
}
