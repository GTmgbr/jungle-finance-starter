import { randomUUID, createHash } from 'node:crypto';
import { Injectable, Inject, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueUrlCommand,
  ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { WageringService } from '../modules/wagering/wagering.service';
import { WagerRecord } from '../infrastructure/records';
import { DomainError } from '../domain/errors';
import { TelemetryService } from '../common/telemetry.service';

const CONSUMER = 'wager-transactions-v1';
const INSTANCE = randomUUID();
const SQS_REGION = process.env.AWS_REGION ?? 'us-east-1';
const MAIN_QUEUE = 'wager-transactions.fifo';
const DLQ = 'wager-transactions-dlq.fifo';
const EVENTS_QUEUE = 'wager-events.fifo';
function log(event: string, extras: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ level: 'info', event, instanceId: INSTANCE, ...extras }));
}
function errorLog(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', event,
    errorType: error instanceof Error ? error.name : 'unknown', instanceId: INSTANCE }));
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

@Injectable()
export class WorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly sqs = new SQSClient({ region: SQS_REGION,
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
    maxAttempts: 2,
  });
  private stopping = false;
  private readonly running: Array<Promise<void>> = [];
  private readonly urls = new Map<string, string>();
  constructor(@Inject('DATA_SOURCE') private readonly db: DataSource,
    private readonly wagering: WageringService,
    private readonly telemetry: TelemetryService) {}

  onModuleInit(): void {
    this.running.push(this.loop('references', () => this.referencesOnce(), 1000));
    this.running.push(this.loop('outbox', () => this.outboxOnce(), 1000));
    this.running.push(this.consumeLoop());
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    // O polling SQS tem até 5 segundos de long polling; operações em andamento terminam antes do shutdown.
    await Promise.allSettled(this.running);
    this.sqs.destroy();
  }
  private async loop(name: string, job: () => Promise<void>, pause: number): Promise<void> {
    while (!this.stopping) {
      try { await job(); } catch (err) { errorLog(`${name}_worker_error`, err); }
      if (!this.stopping) await sleep(pause);
    }
  }
  private async queue(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const r = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!r.QueueUrl) throw new Error(`queue URL missing: ${name}`);
    // LocalStack pode devolver localhost.localstack.cloud; no container isso aponta
    // para o próprio processo, não para o serviço localstack. Preservar o path.
    const url = new URL(r.QueueUrl);
    if (process.env.SQS_ENDPOINT) {
      const local = new URL(process.env.SQS_ENDPOINT);
      url.protocol = local.protocol; url.host = local.host;
    }
    const resolved = url.toString();
    this.urls.set(name, resolved);
    return resolved;
  }

  private async referencesOnce(): Promise<void> {
    const ids = await this.db.getRepository(WagerRecord).createQueryBuilder('tx')
      .select('tx.id', 'id')
      .where('tx.status = :status AND tx.nextAttemptAt <= NOW()', { status: 'PENDING_REFERENCE' })
      .orderBy('tx.nextAttemptAt', 'ASC').limit(20).getRawMany<{ id: string }>();
    for (const { id } of ids) {
      if (this.stopping) break;
      try {
        this.telemetry.referenceRetry();
        await this.wagering.retryReference(id);
      }
      catch (err) { errorLog('reference_retry_error', err); }
    }
  }

  private async outboxOnce(): Promise<void> {
    const due: Array<{ id: string; aggregate_id: string; payload: object; attempts: number }> =
      await this.db.transaction(async manager => {
        // SELECT sempre retorna as linhas no TypeORM/Postgres. UPDATE ... RETURNING
        // retornaria [rows, rowCount], portanto nao deve ser usado como array
        // diretamente. A selecao e a reserva continuam atomicas no mesmo commit.
        const rows: Array<{ id: string; aggregate_id: string; payload: object; attempts: number }> =
          await manager.query(`
          SELECT id, aggregate_id, payload, attempts FROM outbox_messages
          WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            AND (locked_until IS NULL OR locked_until < NOW())
          ORDER BY occurred_at, id LIMIT 20 FOR UPDATE SKIP LOCKED
          `);
        if (rows.length > 0) {
          await manager.query(`
            UPDATE outbox_messages
            SET lock_owner=$1, locked_until=NOW() + INTERVAL '45 seconds'
            WHERE id = ANY($2::uuid[])
          `, [INSTANCE, rows.map(row => row.id)]);
        }
        return rows;
      });
    for (const row of due) {
      if (this.stopping) return;
      try {
        await this.sqs.send(new SendMessageCommand({
          QueueUrl: await this.queue(EVENTS_QUEUE),
          MessageGroupId: row.aggregate_id, MessageDeduplicationId: row.id,
          MessageBody: JSON.stringify(row.payload),
        }));
        await this.db.query(`UPDATE outbox_messages SET published_at=NOW(),
          locked_until=NULL, lock_owner=NULL WHERE id=$1 AND lock_owner=$2
          AND published_at IS NULL`, [row.id, INSTANCE]);
      } catch (err) {
        this.telemetry.outboxRetry();
        errorLog('outbox_publish_retry', err);
        const seconds = Math.min(60, 2 ** Math.min(row.attempts, 6));
        await this.db.query(`UPDATE outbox_messages SET attempts=attempts+1,
          next_attempt_at=NOW()+($3 || ' seconds')::interval,
          lock_owner=NULL, locked_until=NULL WHERE id=$1 AND lock_owner=$2`,
          [row.id, INSTANCE, seconds]);
      }
    }
  }

  private async consumeLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const url = await this.queue(MAIN_QUEUE);
        const response = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: url, MaxNumberOfMessages: 5,
          WaitTimeSeconds: 5, VisibilityTimeout: 45,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));
        for (const message of response.Messages ?? []) {
          if (this.stopping) break;
          if (!message.Body || !message.ReceiptHandle) continue;
          const handle = message.ReceiptHandle;
          let shouldAck = false;
          try {
            const envelope: unknown = JSON.parse(message.Body);
            if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
              throw new DomainError('INVALID_PAYLOAD', 'Envelope inválido');
            }
            const e = envelope as Record<string, unknown>;
            if (e.type !== 'WagerTransactionRequested' || typeof e.messageId !== 'string' ||
              !e.messageId || !e.data || typeof e.data !== 'object' || Array.isArray(e.data)) {
              throw new DomainError('INVALID_PAYLOAD', 'Mensagem incompatível');
            }
            const data = e.data as Record<string, unknown>;
            if (typeof data.idempotencyKey !== 'string') {
              throw new DomainError('INVALID_PAYLOAD', 'Idempotency-Key ausente');
            }
            const payloadHash = createHash('sha256').update(message.Body).digest('hex');
            const result = await this.wagering.submit(data, data.idempotencyKey, {
              consumerName: CONSUMER, messageId: e.messageId, payloadHash,
            });
            shouldAck = true;
            log('sqs_wager_committed', { messageId: e.messageId,
              transactionId: result.transactionId, status: result.status });
          } catch (err) {
            // Mensagens inválidas nunca entrarão no domínio: encaminhar à DLQ e dar ack
            // SOMENTE após a publicação confirmada na DLQ.
            if (err instanceof DomainError) {
              try {
                await this.sqs.send(new SendMessageCommand({
                  QueueUrl: await this.queue(DLQ), MessageGroupId: 'invalid',
                  MessageDeduplicationId: randomUUID(), MessageBody: message.Body,
                }));
                shouldAck = true;
                this.telemetry.dlqSent();
                log('sqs_permanent_to_dlq', { failureCode: err.code });
              } catch (dlqErr) { errorLog('sqs_dlq_unavailable', dlqErr); }
            } else {
              this.telemetry.sqsRetry();
              errorLog('sqs_transient_retry', err);
              // A SQS faz redelivery após visibility timeout e redrive ao atingir maxReceiveCount.
            }
          }
          if (shouldAck) {
            try { await this.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: handle })); }
            catch (err) { errorLog('sqs_ack_retry', err); }
          } else if (this.stopping) {
            await this.sqs.send(new ChangeMessageVisibilityCommand({
              QueueUrl: url, ReceiptHandle: handle, VisibilityTimeout: 0,
            })).catch(() => undefined);
          }
        }
      } catch (err) { errorLog('sqs_poll_error', err); if (!this.stopping) await sleep(1500); }
    }
  }
}
