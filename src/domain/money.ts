import Decimal from 'decimal.js';
import { DomainError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_VALUE = new Decimal('999999999999999999.99');

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' ||
        !AMOUNT_PATTERN.test(props.amount) ||
        typeof props.currency !== 'string' || !CURRENCY_PATTERN.test(props.currency)) {
      throw new DomainError('INVALID_MONEY', 'Valor inválido: use amount como string com 2 casas e currency ISO-4217.');
    }
    const value = new Decimal(props.amount);
    if (!value.isFinite() || value.isNegative() || value.greaterThan(MAX_VALUE)) {
      throw new DomainError('INVALID_MONEY', 'Valor monetário fora do intervalo permitido.');
    }
    return new Money(value, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.plus(other.value);
    if (result.abs().greaterThan(MAX_VALUE)) {
      throw new DomainError('INVALID_MONEY', 'Overflow monetário.');
    }
    return new Money(result, this.currency);
  }

  subtract(other: Money): Money {
    return this.add(other.negate());
  }

  negate(): Money { return new Money(this.value.negated(), this.currency); }
  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.greaterThan(0); }
  isNegative(): boolean { return this.value.lessThan(0); }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }
  toJSON(): MoneyProps { return { amount: this.value.toFixed(2), currency: this.currency }; }
  toString(): string { return this.value.toFixed(2); }
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `${this.currency} != ${other.currency}`);
    }
  }
}
