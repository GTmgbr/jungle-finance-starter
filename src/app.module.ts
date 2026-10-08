import { Module, OnApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { NoopAuthGuard } from './common/auth.guard';
import { createDataSource } from './database/data-source';
import { HealthController } from './modules/health/health.controller';
import { WalletsController } from './modules/wallets/wallets.controller';
import { WalletsService } from './modules/wallets/wallets.service';
import { WageringController } from './modules/wagering/wagering.controller';
import { WageringService } from './modules/wagering/wagering.service';
import { WorkersService } from './workers/workers.service';
import { MetricsController } from './modules/metrics/metrics.controller';
import { TelemetryService } from './common/telemetry.service';

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject('DATA_SOURCE') private readonly db: DataSource) {}
  async onApplicationShutdown(): Promise<void> {
    if (this.db.isInitialized) await this.db.destroy();
  }
}

@Module({
  controllers: [HealthController, WalletsController, WageringController, MetricsController],
  providers: [
    { provide: 'DATA_SOURCE', useFactory: async () => createDataSource().initialize() },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    DbLifecycle, TelemetryService, WalletsService, WageringService, WorkersService,
  ],
})
export class AppModule {}
