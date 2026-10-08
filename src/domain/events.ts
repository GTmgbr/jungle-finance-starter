import { randomUUID } from 'node:crypto';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { MoneyProps } from './money';
import { Wallet } from './wallet';
import { WagerTransaction } from './wager-transaction';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(p: IntegrationEventProps<T>) {
    this.eventId = p.eventId;
    this.aggregateId = p.aggregateId;
    this.correlationId = p.correlationId;
    this.causationId = p.causationId;
    this.occurredAt = p.occurredAt;
    this.data = Object.freeze(p.data);
  }

  toJSON(): {
    eventId: string; eventType: string; aggregateId: string; correlationId: string;
    causationId?: string; occurredAt: string; version: number; data: T;
  } {
    return {
      eventId: this.eventId, eventType: this.eventType,
      aggregateId: this.aggregateId, correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(), version: this.version, data: this.data as T,
    };
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: randomUUID(), aggregateId: wallet.id, correlationId: ctx.correlationId,
      causationId: ctx.causationId, occurredAt: new Date(),
      data: {
        walletId: wallet.id, transactionId: entry.transactionId,
        direction: entry.direction, money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WagerStatusData {
  transactionId: string;
  providerId: string;
  walletId: string;
  status: string;
  failureCode?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerStatusData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: randomUUID(), aggregateId: tx.walletId, correlationId: ctx.correlationId,
      causationId: ctx.causationId, occurredAt: new Date(),
      data: { transactionId: tx.id, providerId: tx.providerId, walletId: tx.walletId, status: tx.status },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerStatusData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: randomUUID(), aggregateId: tx.walletId, correlationId: ctx.correlationId,
      causationId: ctx.causationId, occurredAt: new Date(),
      data: { transactionId: tx.id, providerId: tx.providerId, walletId: tx.walletId,
        status: tx.status, failureCode: tx.failureCode },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerStatusData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: randomUUID(), aggregateId: tx.walletId, correlationId: ctx.correlationId,
      causationId: ctx.causationId, occurredAt: new Date(),
      data: { transactionId: tx.id, providerId: tx.providerId, walletId: tx.walletId, status: tx.status },
    });
  }
}
