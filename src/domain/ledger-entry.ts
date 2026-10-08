import { DomainError } from './errors';
import { Money } from './money';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(p: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(p.id, p.walletId, p.transactionId,
      p.direction, p.money, p.balanceBefore, p.balanceAfter, p.createdAt ?? new Date());
    if (!entry.money.isPositive() || !entry.isBalanced() || entry.balanceAfter.isNegative()) {
      throw new DomainError('INVALID_MONEY', 'Lançamento do ledger não balanceado.');
    }
    return entry;
  }

  static rehydrate(p: Required<CreateLedgerEntryProps>): WalletLedgerEntry {
    return new WalletLedgerEntry(p.id, p.walletId, p.transactionId, p.direction,
      p.money, p.balanceBefore, p.balanceAfter, p.createdAt);
  }

  isBalanced(): boolean {
    const calculated = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return calculated.equals(this.balanceAfter);
  }
}
