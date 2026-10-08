import { Controller, Get, Header, Inject, OnModuleDestroy } from '@nestjs/common';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { TelemetryService } from '../../common/telemetry.service';

/** Endpoint Prometheus simples. Contadores locais devem ser coletados de TODAS as replicas. */
@Controller()
export class MetricsController implements OnModuleDestroy {
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
    maxAttempts: 2,
  });
  constructor(@Inject('DATA_SOURCE') private readonly db: DataSource,
    private readonly telemetry: TelemetryService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    const statuses = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'];
    const statusRows: Array<{ status: string; count: string }> = await this.db.query(`
      SELECT status, COUNT(*)::text AS count FROM wager_transactions GROUP BY status`);
    const counts = new Map(statusRows.map(row => [row.status, row.count]));
    const [outbox]: Array<{ pending: string; published: string; retried: string; lag: string }> =
      await this.db.query(`
        SELECT COUNT(*) FILTER (WHERE published_at IS NULL)::text AS pending,
               COUNT(*) FILTER (WHERE published_at IS NOT NULL)::text AS published,
               COUNT(*) FILTER (WHERE attempts > 0)::text AS retried,
               COALESCE(EXTRACT(EPOCH FROM
                 (NOW() - MIN(CASE WHEN published_at IS NULL THEN occurred_at END))), 0)::text AS lag
        FROM outbox_messages`);
    const lines: string[] = [
      '# HELP jungle_wager_transactions Transacoes no estado atual, fonte PostgreSQL',
      '# TYPE jungle_wager_transactions gauge',
      ...statuses.map(s => `jungle_wager_transactions{status="${s}"} ${counts.get(s) ?? '0'}`),
      '# HELP jungle_outbox_pending Eventos ainda nao publicados no banco',
      '# TYPE jungle_outbox_pending gauge',
      `jungle_outbox_pending ${outbox.pending}`,
      '# HELP jungle_outbox_published Eventos marcados como publicados',
      '# TYPE jungle_outbox_published gauge',
      `jungle_outbox_published ${outbox.published}`,
      '# HELP jungle_outbox_retried_events Eventos com pelo menos uma tentativa anterior',
      '# TYPE jungle_outbox_retried_events gauge',
      `jungle_outbox_retried_events ${outbox.retried}`,
      '# HELP jungle_outbox_oldest_pending_seconds Idade do evento pendente mais antigo',
      '# TYPE jungle_outbox_oldest_pending_seconds gauge',
      `jungle_outbox_oldest_pending_seconds ${outbox.lag}`,
    ];
    try {
      const queue = await this.sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions-dlq.fifo' }));
      if (!queue.QueueUrl) throw new Error('DLQ sem URL');
      const target = new URL(queue.QueueUrl);
      if (process.env.SQS_ENDPOINT) {
        const endpoint = new URL(process.env.SQS_ENDPOINT);
        target.protocol = endpoint.protocol;
        target.host = endpoint.host;
      }
      const result = await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: target.toString(), AttributeNames: [
          'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesDelayed',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }));
      const attrs = result.Attributes ?? {};
      const depth = Number(attrs.ApproximateNumberOfMessages ?? '0') +
        Number(attrs.ApproximateNumberOfMessagesDelayed ?? '0') +
        Number(attrs.ApproximateNumberOfMessagesNotVisible ?? '0');
      lines.push('# TYPE jungle_dlq_depth gauge', `jungle_dlq_depth ${depth}`);
      lines.push('# TYPE jungle_dlq_metrics_available gauge', 'jungle_dlq_metrics_available 1');
    } catch {
      // Não mascarar a falha com valor zero (zero significaria fila comprovadamente vazia).
      lines.push('# TYPE jungle_dlq_metrics_available gauge', 'jungle_dlq_metrics_available 0');
    }
    return [...lines, ...this.telemetry.render(), ''].join('\n');
  }

  onModuleDestroy(): void { this.sqs.destroy(); }
}
