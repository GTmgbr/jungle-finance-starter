import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Controller, Get, HttpException, Inject, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
  });

  constructor(@Inject('DATA_SOURCE') private readonly db: DataSource) {}

  @Get('live')
  live() { return { status: 'ok' }; }

  @Get('ready')
  async ready() {
    try {
      await this.db.query('SELECT 1');
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
      return { status: 'ready', postgres: 'up', sqs: 'up' };
    } catch {
      throw new HttpException({ status: 'unavailable', postgresOrSqs: 'down' }, 503);
    }
  }

  onModuleDestroy(): void { this.sqs.destroy(); }
}
