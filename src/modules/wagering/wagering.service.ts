import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { enqueueEvent } from '../../common/outbox';
import { parsedMoney, requiredString, requiredUUID } from '../../common/validation';
import { WalletBalanceChanged, WagerTransactionPendingReference,
  WagerTransactionProcessed, WagerTransactionRejected } from '../../domain/events';
import { DomainError, FailureCode } from '../../domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { InboxRecord, LedgerRecord, WagerRecord, WalletRecord } from '../../infrastructure/records';
import { TelemetryService } from '../../common/telemetry.service';

interface WagerInput {
  providerId: string; externalTransactionId: string; playerId: string;
  walletId: string; roundId: string; gameId: string; kind: WagerTransactionKind;
  money: Money; referenceExternalTransactionId?: string;
}
export interface WagerReceipt {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}
export interface InboxContext { consumerName: string; messageId: string; payloadHash: string }

function parseInput(body: unknown): WagerInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DomainError('INVALID_PAYLOAD', 'Body deve ser objeto.');
  }
  const b = body as Record<string, unknown>;
  const kind = requiredString(b.kind, 'kind') as WagerTransactionKind;
  if (!Object.values(WagerTransactionKind).includes(kind) || kind === WagerTransactionKind.Opening) {
    throw new DomainError('INVALID_PAYLOAD', 'Tipo de transação inválido.');
  }
  const ref = b.referenceExternalTransactionId === undefined
    ? undefined : requiredString(b.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if (ref && [WagerTransactionKind.Bet, WagerTransactionKind.Loss].includes(kind)) {
    throw new DomainError('INVALID_PAYLOAD', 'BET e LOSS não aceitam referência.');
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !ref) {
    throw new DomainError('INVALID_PAYLOAD', 'Reversão exige referência.');
  }
  return {
    providerId: requiredString(b.providerId, 'providerId', 100),
    externalTransactionId: requiredString(b.externalTransactionId, 'externalTransactionId'),
    playerId: requiredUUID(b.playerId, 'playerId'), walletId: requiredUUID(b.walletId, 'walletId'),
    roundId: requiredString(b.roundId, 'roundId'), gameId: requiredString(b.gameId, 'gameId'),
    kind, money: parsedMoney(b.money), referenceExternalTransactionId: ref,
  };
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortedJson(v)]));
  }
  return value;
}
export function canonicalHash(input: WagerInput): string {
  const data: Record<string, unknown> = {
    providerId: input.providerId, externalTransactionId: input.externalTransactionId,
    playerId: input.playerId, walletId: input.walletId, roundId: input.roundId,
    gameId: input.gameId, kind: input.kind, money: input.money.toJSON(),
  };
  if (input.referenceExternalTransactionId) data.referenceExternalTransactionId = input.referenceExternalTransactionId;
  return createHash('sha256').update(JSON.stringify(sortedJson(data))).digest('hex');
}

function rehydrateTransaction(row: WagerRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id, providerId: row.providerId, externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey, payloadHash: row.payloadHash,
    walletId: row.walletId, playerId: row.playerId, roundId: row.roundId, gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    createdAt: row.createdAt, status: row.status as WagerTransactionStatus,
    failureCode: row.failureCode as FailureCode | undefined ?? undefined,
    processedAt: row.processedAt ?? undefined,
    resultBalance: row.resultBalance ? Money.from({ amount: row.resultBalance, currency: row.currency }) : undefined,
  });
}

@Injectable()
export class WageringService {
  constructor(@Inject('DATA_SOURCE') private readonly db: DataSource,
    private readonly telemetry: TelemetryService) {}

  async submit(body: unknown, idempotencyKey: string | undefined, inbox?: InboxContext): Promise<WagerReceipt> {
    const input = parseInput(body);
    const key = requiredString(idempotencyKey, 'Idempotency-Key', 255);
    const hash = canonicalHash(input);
    const started = Date.now();
    let result: WagerReceipt;
    try {
      result = await this.db.transaction('READ COMMITTED', async manager => {
      // Sempre bloquear a wallet primeiro: evita lost updates e inversão da ordem de locks.
      const wallet = await this.lockWallet(manager, input.walletId, input.playerId, input.money.currency);
      const sameKey = await manager.findOneBy(WagerRecord, { idempotencyKey: key });
      const sameExternal = await manager.findOneBy(WagerRecord, {
        providerId: input.providerId, externalTransactionId: input.externalTransactionId,
      });
      const existing = sameKey ?? sameExternal;
      if (existing) {
        if (existing.idempotencyKey !== key || existing.payloadHash !== hash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Key ou ID externo reutilizado com payload divergente.');
        }
        await this.recordInbox(manager, inbox);
        return this.receipt(existing, true);
      }
      const tx = WagerTransaction.create({
        id: randomUUID(), providerId: input.providerId,
        externalTransactionId: input.externalTransactionId, idempotencyKey: key,
        payloadHash: hash, walletId: input.walletId, playerId: input.playerId,
        roundId: input.roundId, gameId: input.gameId, kind: input.kind,
        money: input.money, referenceExternalTransactionId: input.referenceExternalTransactionId,
      });
      const receipt = await this.apply(manager, tx, wallet, 0, true);
      await this.recordInbox(manager, inbox);
      return receipt;
      });
    } catch (err) {
      if (['55P03', '40P01', '40001'].includes((err as { code?: string })?.code ?? '')) {
        this.telemetry.lockConflict();
      }
      throw err;
    } finally {
      this.telemetry.observeLatency((Date.now() - started) / 1000);
    }
    if (result.idempotentReplay) this.telemetry.replay();
    console.info(JSON.stringify({ level: 'info', event: 'wager_committed',
      transactionId: result.transactionId, walletId: input.walletId,
      providerId: input.providerId, correlationId: key, status: result.status,
      messageId: inbox?.messageId }));
    return result;
  }

  // Worker recebe IDs candidatos fora da transação, mas bloqueia a wallet e revalida status.
  async retryReference(id: string): Promise<void> {
    const original = await this.db.getRepository(WagerRecord).findOneBy({ id });
    if (!original || original.status !== WagerTransactionStatus.PendingReference) return;
    await this.db.transaction('READ COMMITTED', async manager => {
      const wallet = await this.lockWallet(manager, original.walletId, original.playerId, original.currency);
      const row = await manager.findOneBy(WagerRecord, { id });
      if (!row || row.status !== WagerTransactionStatus.PendingReference ||
        (row.nextAttemptAt && row.nextAttemptAt > new Date())) return;
      await this.apply(manager, rehydrateTransaction(row), wallet, row.attempts, false);
    });
  }

  private async lockWallet(manager: EntityManager, walletId: string, playerId: string, currency: string): Promise<Wallet> {
    const row = await manager.findOne(WalletRecord, {
      where: { id: walletId }, lock: { mode: 'pessimistic_write' },
    });
    if (!row) throw new DomainError('WALLET_NOT_FOUND', 'Wallet não encontrada.');
    if (row.playerId !== playerId) throw new DomainError('WALLET_MISMATCH', 'Wallet não pertence ao player informado.');
    if (row.currency !== currency) throw new DomainError('CURRENCY_MISMATCH', 'Moeda da operação difere da wallet.');
    return Wallet.rehydrate({ id: row.id, playerId: row.playerId, currency: row.currency,
      balance: Money.from({ amount: row.balance, currency: row.currency }), version: row.version,
      createdAt: row.createdAt, updatedAt: row.updatedAt });
  }

  private async recordInbox(manager: EntityManager, inbox?: InboxContext): Promise<void> {
    if (!inbox) return;
    const previous = await manager.findOneBy(InboxRecord, {
      consumerName: inbox.consumerName, messageId: inbox.messageId,
    });
    if (previous) {
      if (previous.payloadHash !== inbox.payloadHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'messageId reutilizado com payload diferente.');
      }
      return;
    }
    await manager.insert(InboxRecord, {
      consumerName: inbox.consumerName, messageId: inbox.messageId,
      payloadHash: inbox.payloadHash, receivedAt: new Date(), processedAt: new Date(),
    });
  }

  private async apply(manager: EntityManager, tx: WagerTransaction, wallet: Wallet,
    attempts: number, newTransaction: boolean): Promise<WagerReceipt> {
    let reference: WagerTransaction | undefined;
    let failure: FailureCode | undefined;
    let pending = false;
    if (tx.referenceExternalTransactionId) {
      const row = await manager.findOneBy(WagerRecord, {
        providerId: tx.providerId, externalTransactionId: tx.referenceExternalTransactionId,
      });
      if (!row || (row.status === WagerTransactionStatus.Pending ||
        row.status === WagerTransactionStatus.PendingReference)) {
        pending = true;
      } else if (row.status !== WagerTransactionStatus.Processed) {
        failure = 'INVALID_REFERENCE';
      } else {
        reference = rehydrateTransaction(row);
        const mismatch = reference.id === tx.id || reference.walletId !== tx.walletId ||
          reference.playerId !== tx.playerId || reference.roundId !== tx.roundId ||
          reference.money.currency !== tx.money.currency ||
          (tx.kind !== WagerTransactionKind.Win && !reference.money.equals(tx.money));
        const incorrectKind = tx.kind === WagerTransactionKind.Refund &&
          reference.kind !== WagerTransactionKind.Bet ||
          tx.kind === WagerTransactionKind.Rollback &&
          ![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(reference.kind) ||
          tx.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet;
        if (mismatch || incorrectKind) failure = 'INVALID_REFERENCE';
        if (!failure && (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback)) {
          const previous = await manager.findOneBy(WagerRecord, {
            providerId: tx.providerId, referenceTransactionId: reference.id, kind: tx.kind,
          });
          if (previous && previous.id !== tx.id) failure = 'REFERENCE_ALREADY_REVERSED';
        }
      }
    }
    let entry: WalletLedgerEntry | undefined;
    if (pending && !failure) {
      // No máximo 8 tentativas (1s, 2s, ...); resultados finais ficam auditáveis.
      if (attempts + 1 >= 8) failure = 'REFERENCE_NOT_FOUND';
      else tx.markPendingReference();
    }
    if (!pending && !failure) {
      let direction: LedgerDirection | undefined;
      if (tx.kind !== WagerTransactionKind.Loss) direction = tx.ledgerDirectionFor(reference);
      if (direction) {
        try {
          const movement = direction === LedgerDirection.Credit ? wallet.credit(tx.money)
            : wallet.debit(tx.money, tx.kind === WagerTransactionKind.Rollback
              ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
          entry = WalletLedgerEntry.create({ id: randomUUID(), walletId: wallet.id,
            transactionId: tx.id, direction, money: tx.money,
            balanceBefore: movement.before, balanceAfter: movement.after });
        } catch (error) {
          if (error instanceof DomainError &&
              ['INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS'].includes(error.code)) {
            failure = error.code;
          } else throw error;
        }
      }
    }
    if (failure) tx.reject(failure, wallet.balance);
    else if (!pending) tx.markProcessed(reference?.id, new Date(), wallet.balance);
    const nextAttempt = tx.status === WagerTransactionStatus.PendingReference
      ? new Date(Date.now() + Math.min(60000, 1000 * 2 ** attempts)) : null;
    if (newTransaction) {
      await manager.insert(WagerRecord, {
        id: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey, payloadHash: tx.payloadHash,
        walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId,
        kind: tx.kind, amount: tx.money.toString(), currency: tx.money.currency,
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        // Rejeições não reservam a restrição UNIQUE de reversão bem-sucedida.
        referenceTransactionId: failure || pending ? null : reference?.id ?? null,
        status: tx.status, failureCode: tx.failureCode ?? null,
        resultBalance: wallet.balance.toString(), attempts: pending ? 1 : 0,
        nextAttemptAt: nextAttempt, createdAt: tx.createdAt,
        processedAt: tx.processedAt ?? null,
      });
    } else {
      await manager.update(WagerRecord, { id: tx.id }, {
        status: tx.status, failureCode: tx.failureCode ?? null,
        referenceTransactionId: failure || pending ? null : reference?.id ?? null,
        resultBalance: wallet.balance.toString(), attempts: attempts + 1,
        nextAttemptAt: nextAttempt, processedAt: tx.processedAt ?? null,
      });
    }
    if (entry) {
      await manager.update(WalletRecord, { id: wallet.id }, {
        balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt,
      });
      await manager.insert(LedgerRecord, {
        id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
        direction: entry.direction, amount: entry.money.toString(), currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(),
        createdAt: entry.createdAt,
      });
      await enqueueEvent(manager, WalletBalanceChanged.from(wallet, entry,
        { correlationId: tx.idempotencyKey, causationId: tx.id }));
    }
    if (tx.status === WagerTransactionStatus.Rejected) {
      await enqueueEvent(manager, WagerTransactionRejected.from(tx,
        { correlationId: tx.idempotencyKey, causationId: tx.id }));
    } else if (tx.status === WagerTransactionStatus.Processed) {
      await enqueueEvent(manager, WagerTransactionProcessed.from(tx,
        { correlationId: tx.idempotencyKey, causationId: tx.id }));
    } else if (newTransaction && tx.status === WagerTransactionStatus.PendingReference) {
      await enqueueEvent(manager, WagerTransactionPendingReference.from(tx,
        { correlationId: tx.idempotencyKey, causationId: tx.id }));
    }
    return { transactionId: tx.id, status: tx.status, balance: wallet.balance.toJSON(),
      idempotentReplay: false, ...(tx.failureCode ? { failureCode: tx.failureCode } : {}) };
  }

  async getById(id: string): Promise<Record<string, unknown>> {
    requiredUUID(id, 'transactionId');
    const row = await this.db.getRepository(WagerRecord).findOneBy({ id });
    if (!row) throw new DomainError('WALLET_NOT_FOUND', 'Transação não encontrada.');
    return this.present(row);
  }
  async getByExternal(providerId: string, externalId: string): Promise<Record<string, unknown>> {
    requiredString(providerId, 'providerId', 100);
    requiredString(externalId, 'externalTransactionId');
    const row = await this.db.getRepository(WagerRecord).findOneBy({
      providerId, externalTransactionId: externalId,
    });
    if (!row) throw new DomainError('WALLET_NOT_FOUND', 'Transação não encontrada.');
    return this.present(row);
  }
  private receipt(row: WagerRecord, replay: boolean): WagerReceipt {
    return { transactionId: row.id, status: row.status as WagerTransactionStatus,
      balance: { amount: row.resultBalance!, currency: row.currency }, idempotentReplay: replay,
      ...(row.failureCode ? { failureCode: row.failureCode } : {}) };
  }
  private present(row: WagerRecord): Record<string, unknown> {
    return { transactionId: row.id, providerId: row.providerId,
      externalTransactionId: row.externalTransactionId, walletId: row.walletId,
      playerId: row.playerId, roundId: row.roundId, gameId: row.gameId,
      kind: row.kind, money: { amount: row.amount, currency: row.currency },
      status: row.status, failureCode: row.failureCode,
      balance: row.resultBalance ? { amount: row.resultBalance, currency: row.currency } : null,
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      createdAt: row.createdAt.toISOString(), processedAt: row.processedAt?.toISOString() ?? null };
  }
}
