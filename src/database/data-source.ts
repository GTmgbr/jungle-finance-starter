import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { WalletRecord, WagerRecord, LedgerRecord, InboxRecord, OutboxRecord } from '../infrastructure/records';
import { InitialSchema2026100700000 } from './migrations/2026100700000-InitialSchema';

export function createDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL ?? 'postgres://jungle:jungle@localhost:5432/jungle_finance',
    synchronize: false,
    logging: false,
    entities: [WalletRecord, WagerRecord, LedgerRecord, InboxRecord, OutboxRecord],
    migrations: [InitialSchema2026100700000],
    migrationsTransactionMode: 'all',
    extra: { max: 15, connectionTimeoutMillis: 5000 },
  });
}
