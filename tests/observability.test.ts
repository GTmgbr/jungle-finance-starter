import { describe, expect, test } from 'bun:test';
import { TelemetryService } from '../src/common/telemetry.service';

describe('Observabilidade', () => {
  test('instrumenta replays, retries, lock e latencia sem alterar dominio', () => {
    const metrics = new TelemetryService();
    metrics.replay();
    metrics.outboxRetry();
    metrics.sqsRetry();
    metrics.referenceRetry();
    metrics.dlqSent();
    metrics.lockConflict();
    metrics.reconciliationMismatch();
    metrics.observeLatency(0.02);
    metrics.observeLatency(0.2);
    const text = metrics.render().join('\n');
    expect(text).toContain('jungle_idempotent_replays_total 1');
    expect(text).toContain('jungle_outbox_retries_total 1');
    expect(text).toContain('jungle_sqs_retries_total 1');
    expect(text).toContain('jungle_reference_retries_total 1');
    expect(text).toContain('jungle_dlq_sent_total 1');
    expect(text).toContain('jungle_lock_conflicts_total 1');
    expect(text).toContain('jungle_reconciliation_mismatches_total 1');
    expect(text).toContain('jungle_wager_processing_seconds_bucket{le="0.05"} 1');
    expect(text).toContain('jungle_wager_processing_seconds_bucket{le="+Inf"} 2');
  });
});
