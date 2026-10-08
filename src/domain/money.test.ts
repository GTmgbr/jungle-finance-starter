import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money (sem number para valores financeiros)', () => {
  test('preserva precisão e retorna nova instância', () => {
    const original = brl('0.10');
    expect(original.add(brl('0.20')).toString()).toBe('0.30');
    expect(original.toString()).toBe('0.10');
    expect(brl('2.00').subtract(brl('3.00')).toString()).toBe('-1.00');
  });
  test('rejeita inválidos, negativos e escala incorreta', () => {
    for (const amount of ['', 'NaN', 'Infinity', '1e3', '-2.00', '2.001', '2.0', '2', ' 2.00']) {
      expect(() => brl(amount)).toThrow();
    }
  });
  test('bloqueia operações entre moedas', () => {
    expect(() => brl('1.00').add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow();
  });
});

describe('Wallet e ledger', () => {
  test('débito seguro, incremento de versão e ledger balanceado', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100.00') });
    const movement = wallet.debit(brl('80.00'));
    const entry = WalletLedgerEntry.create({ id: 'entry-1', walletId: wallet.id,
      transactionId: 'tx-1', direction: LedgerDirection.Debit, money: brl('80.00'),
      balanceBefore: movement.before, balanceAfter: movement.after });
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(() => wallet.debit(brl('80.00'))).toThrow();
    expect(wallet.version).toBe(2);
    expect(wallet.balance.toString()).toBe('20.00');
  });
  test('ledger inconsistente não é aceito', () => {
    expect(() => WalletLedgerEntry.create({ id: 'e', walletId: 'w', transactionId: 't',
      direction: LedgerDirection.Credit, money: brl('1.00'),
      balanceBefore: brl('2.00'), balanceAfter: brl('5.00') })).toThrow();
  });
  test('estado terminal não permite nova transição', () => {
    const tx = WagerTransaction.create({ id: 't', providerId: 'p', externalTransactionId: 'x',
      idempotencyKey: 'p:x', payloadHash: '0'.repeat(64), walletId: 'w', playerId: 'p',
      roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Loss, money: brl('1.00') });
    tx.markProcessed(undefined, new Date(), brl('2.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(() => tx.reject('INVALID_REFERENCE', brl('2.00'))).toThrow();
  });
});
