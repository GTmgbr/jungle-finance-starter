import { DomainError } from './errors';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError('INVALID_MONEY', 'Saldo inicial negativo.');
    }
    const now = new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency,
      props.initialBalance, 1, now, now);
  }

  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  debit(money: Money, failureCode: 'INSUFFICIENT_FUNDS' | 'REVERSAL_INSUFFICIENT_FUNDS' = 'INSUFFICIENT_FUNDS'):
    { before: Money; after: Money } {
    this.assertMovement(money);
    if (this._balance.isLessThan(money)) {
      throw new DomainError(failureCode, 'Saldo insuficiente.');
    }
    const before = this._balance;
    this._balance = before.subtract(money);
    this._version++;
    this._updatedAt = new Date();
    return { before, after: this._balance };
  }

  credit(money: Money): { before: Money; after: Money } {
    this.assertMovement(money);
    const before = this._balance;
    this._balance = before.add(money);
    this._version++;
    this._updatedAt = new Date();
    return { before, after: this._balance };
  }

  private assertMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Moeda da wallet e da operação diferem.');
    }
    if (!money.isPositive()) {
      throw new DomainError('INVALID_MONEY', 'Movimento financeiro precisa ser positivo.');
    }
  }
}
