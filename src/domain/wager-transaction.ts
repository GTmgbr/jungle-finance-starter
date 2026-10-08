import { DomainError, FailureCode } from './errors';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS',
  Refund = 'REFUND', Rollback = 'ROLLBACK',
}
export enum WagerTransactionStatus {
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED',
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
  ) {}

  static create(p: Omit<WagerTransactionState, 'createdAt' | 'status'>): WagerTransaction {
    if (p.kind === WagerTransactionKind.Opening) {
      throw new DomainError('INVALID_PAYLOAD', 'OPENING é exclusivo do sistema.');
    }
    if ((p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback)
      && !p.referenceExternalTransactionId) {
      throw new DomainError('INVALID_PAYLOAD', 'Reversão exige referência.');
    }
    if (!p.money.isPositive()) {
      throw new DomainError('INVALID_MONEY', 'Valor precisa ser maior que zero.');
    }
    return new WagerTransaction(p.id, p.providerId, p.externalTransactionId,
      p.idempotencyKey, p.payloadHash, p.walletId, p.playerId, p.roundId, p.gameId,
      p.kind, p.money, p.referenceExternalTransactionId, new Date(), WagerTransactionStatus.Pending);
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(s.id, s.providerId, s.externalTransactionId,
      s.idempotencyKey, s.payloadHash, s.walletId, s.playerId, s.roundId, s.gameId,
      s.kind, s.money, s.referenceExternalTransactionId, s.createdAt, s.status,
      s.referenceTransactionId, s.failureCode, s.processedAt, s.resultBalance);
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get resultBalance(): Money | undefined { return this._resultBalance; }
  isTerminal(): boolean {
    return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed].includes(this._status);
  }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if ([WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Opening].includes(this.kind)) {
      return LedgerDirection.Credit;
    }
    if (this.kind === WagerTransactionKind.Rollback && reference) {
      return reference.ledgerDirectionFor() === LedgerDirection.Credit
        ? LedgerDirection.Debit : LedgerDirection.Credit;
    }
    throw new DomainError('INVALID_REFERENCE', 'Direção de ledger indisponível.');
  }
  markProcessed(referenceId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
  }
  markPendingReference(): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
  }
  reject(code: FailureCode, resultBalance: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date();
    this._resultBalance = resultBalance;
  }
  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date();
  }
  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new DomainError('INVALID_TRANSACTION_STATE', 'Transação em estado terminal.');
    }
  }
}
