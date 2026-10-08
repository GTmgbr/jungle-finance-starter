import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { parsedMoney, requiredUUID } from '../../common/validation';
import { enqueueEvent } from '../../common/outbox';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../../domain/events';
import { DomainError } from '../../domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { LedgerRecord, WagerRecord, WalletRecord } from '../../infrastructure/records';
import { TelemetryService } from '../../common/telemetry.service';

interface Cursor { createdAt: string; id: string }

@Injectable()
export class WalletsService {
  constructor(@Inject('DATA_SOURCE') private readonly db: DataSource,
    private readonly telemetry: TelemetryService) {}

  async create(body: unknown): Promise<Record<string, unknown>> {
    if (!body || typeof body !== 'object') throw new DomainError('INVALID_PAYLOAD', 'Body inválido.');
    const b = body as Record<string, unknown>;
    const playerId = requiredUUID(b.playerId, 'playerId');
    const initial = parsedMoney(b.initialBalance);
    const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance: initial });

    await this.db.transaction(async (manager) => {
      await manager.insert(WalletRecord, {
        id: wallet.id, playerId, currency: wallet.currency,
        balance: wallet.balance.toString(), version: wallet.version,
        createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
      });
      if (initial.isZero()) return;

      const openingId = randomUUID();
      const opening = WagerTransaction.rehydrate({
        id: openingId, providerId: 'INTERNAL', externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `internal:opening:${wallet.id}`, payloadHash: '0'.repeat(64),
        walletId: wallet.id, playerId, roundId: 'opening', gameId: 'opening',
        kind: WagerTransactionKind.Opening, money: initial, status: WagerTransactionStatus.Processed,
        createdAt: wallet.createdAt, processedAt: wallet.createdAt, resultBalance: initial,
      });
      await manager.insert(WagerRecord, {
        id: opening.id, providerId: opening.providerId,
        externalTransactionId: opening.externalTransactionId, idempotencyKey: opening.idempotencyKey,
        payloadHash: opening.payloadHash, walletId: wallet.id, playerId, roundId: 'opening', gameId: 'opening',
        kind: opening.kind, amount: initial.toString(), currency: initial.currency,
        referenceExternalTransactionId: null, referenceTransactionId: null,
        status: opening.status, failureCode: null, resultBalance: initial.toString(),
        attempts: 0, nextAttemptAt: null, createdAt: wallet.createdAt, processedAt: wallet.createdAt,
      });
      const entry = WalletLedgerEntry.create({
        id: randomUUID(), walletId: wallet.id, transactionId: openingId,
        direction: LedgerDirection.Credit, money: initial,
        balanceBefore: Money.zero(initial.currency), balanceAfter: initial,
      });
      await manager.insert(LedgerRecord, {
        id: entry.id, walletId: wallet.id, transactionId: openingId,
        direction: entry.direction, amount: entry.money.toString(), currency: initial.currency,
        balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(),
        createdAt: entry.createdAt,
      });
      const ctx = { correlationId: openingId };
      await enqueueEvent(manager, WagerTransactionProcessed.from(opening, ctx));
      await enqueueEvent(manager, WalletBalanceChanged.from(wallet, entry, ctx));
    });

    return this.presentWallet(wallet.id, wallet.playerId, wallet.balance, wallet.version);
  }

  async get(walletId: string): Promise<Record<string, unknown>> {
    requiredUUID(walletId, 'walletId');
    const wallet = await this.db.getRepository(WalletRecord).findOneBy({ id: walletId });
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 'Wallet não encontrada.');
    return this.presentWallet(wallet.id, wallet.playerId,
      Money.from({ amount: wallet.balance, currency: wallet.currency }), wallet.version);
  }

  async ledger(walletId: string, cursor: string | undefined, limitValue: string | undefined): Promise<Record<string, unknown>> {
    requiredUUID(walletId, 'walletId');
    const n = limitValue === undefined ? 50 : Number(limitValue);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new DomainError('INVALID_PAYLOAD', 'limit deve estar entre 1 e 100.');
    }
    let decoded: Cursor | undefined;
    if (cursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!value || typeof value !== 'object') throw new Error('cursor inválido');
        const c = value as Cursor;
        if (!Number.isFinite(Date.parse(c.createdAt))) throw new Error('data inválida');
        requiredUUID(c.id, 'cursor.id');
        decoded = c;
      } catch { throw new DomainError('INVALID_PAYLOAD', 'Cursor inválido.'); }
    }
    const walletExists = await this.db.getRepository(WalletRecord).existsBy({ id: walletId });
    if (!walletExists) throw new DomainError('WALLET_NOT_FOUND', 'Wallet não encontrada.');
    const rows: Array<{ id: string; transaction_id: string; direction: string; amount: string;
      currency: string; balance_before: string; balance_after: string; created_at: Date }> = decoded
      ? await this.db.query(`SELECT id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at
          FROM wallet_ledger_entries WHERE wallet_id=$1 AND (created_at,id)>($2::timestamptz,$3::uuid)
          ORDER BY created_at,id LIMIT $4`, [walletId, decoded.createdAt, decoded.id, n])
      : await this.db.query(`SELECT id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at
          FROM wallet_ledger_entries WHERE wallet_id=$1 ORDER BY created_at,id LIMIT $2`, [walletId, n]);
    const last = rows[rows.length - 1];
    return {
      items: rows.map((r) => ({
        id: r.id, transactionId: r.transaction_id, direction: r.direction,
        money: { amount: r.amount, currency: r.currency },
        balanceBefore: { amount: r.balance_before, currency: r.currency },
        balanceAfter: { amount: r.balance_after, currency: r.currency },
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: last && rows.length === n
        ? Buffer.from(JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id })).toString('base64url')
        : null,
    };
  }

  async reconcile(walletId: string): Promise<Record<string, unknown>> {
    requiredUUID(walletId, 'walletId');
    // REPEATABLE READ garante que saldo e ledger são vistos no mesmo snapshot.
    const result = await this.db.transaction('REPEATABLE READ', async (manager) => {
      const wallet = await manager.findOneBy(WalletRecord, { id: walletId });
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 'Wallet não encontrada.');
      const [row]: Array<{ calculated: string; count: string }> = await manager.query(`
        SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0)::numeric(20,2) AS calculated,
               COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id=$1
      `, [walletId]);
      const stored = Money.from({ amount: wallet.balance, currency: wallet.currency });
      const calculated = Money.from({ amount: row.calculated, currency: wallet.currency });
      return {
        walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(),
        difference: stored.subtract(calculated).toJSON(), consistent: stored.equals(calculated),
        checkedEntries: Number(row.count),
      };
    });
    if (!result.consistent) {
      this.telemetry.reconciliationMismatch();
      console.error(JSON.stringify({ level: 'error', event: 'reconciliation_divergence', walletId }));
    }
    return result;
  }

  private presentWallet(id: string, playerId: string, balance: Money, version: number): Record<string, unknown> {
    return { id, playerId, balance: balance.toJSON(), version };
  }
}
