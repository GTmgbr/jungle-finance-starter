import { Injectable } from '@nestjs/common';

@Injectable()
export class TelemetryService {
  private readonly counters: Record<'replays' | 'outboxRetries' | 'sqsRetries' |
    'referenceRetries' | 'dlqSent' | 'lockConflicts' | 'reconciliationMismatches', number> = {
    replays: 0, outboxRetries: 0, sqsRetries: 0, referenceRetries: 0,
    dlqSent: 0, lockConflicts: 0, reconciliationMismatches: 0,
  };
  private latencyCount = 0;
  private latencySum = 0;
  private readonly bounds = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];
  private readonly latencyBuckets = this.bounds.map(() => 0);

  replay(): void { this.counters.replays++; }
  outboxRetry(): void { this.counters.outboxRetries++; }
  sqsRetry(): void { this.counters.sqsRetries++; }
  referenceRetry(): void { this.counters.referenceRetries++; }
  dlqSent(): void { this.counters.dlqSent++; }
  lockConflict(): void { this.counters.lockConflicts++; }
  reconciliationMismatch(): void { this.counters.reconciliationMismatches++; }

  observeLatency(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.latencyCount++;
    this.latencySum += seconds;
    this.bounds.forEach((bound, index) => {
      if (seconds <= bound) this.latencyBuckets[index]++;
    });
  }

  render(): string[] {
    const items: Array<[string, string, number]> = [
      ['jungle_idempotent_replays_total', 'Replays HTTP e SQS identificados nesta instancia', this.counters.replays],
      ['jungle_outbox_retries_total', 'Falhas de envio da outbox nesta instancia', this.counters.outboxRetries],
      ['jungle_sqs_retries_total', 'Falhas transitorias do consumidor nesta instancia', this.counters.sqsRetries],
      ['jungle_reference_retries_total', 'Tentativas de resolver referencias nesta instancia', this.counters.referenceRetries],
      ['jungle_dlq_sent_total', 'Mensagens enviadas explicitamente a DLQ nesta instancia', this.counters.dlqSent],
      ['jungle_lock_conflicts_total', 'Conflitos e deadlocks detectados nesta instancia', this.counters.lockConflicts],
      ['jungle_reconciliation_mismatches_total', 'Reconciliacoes divergentes nesta instancia', this.counters.reconciliationMismatches],
    ];
    const lines = items.flatMap(([name, help, value]) => [
      `# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${value}`,
    ]);
    lines.push('# HELP jungle_wager_processing_seconds Duracao do processamento HTTP ou SQS de apostas');
    lines.push('# TYPE jungle_wager_processing_seconds histogram');
    this.bounds.forEach((bound, index) => {
      lines.push(`jungle_wager_processing_seconds_bucket{le="${bound}"} ${this.latencyBuckets[index]}`);
    });
    lines.push(`jungle_wager_processing_seconds_bucket{le="+Inf"} ${this.latencyCount}`);
    lines.push(`jungle_wager_processing_seconds_sum ${this.latencySum}`);
    lines.push(`jungle_wager_processing_seconds_count ${this.latencyCount}`);
    return lines;
  }
}
