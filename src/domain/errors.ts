export type FailureCode =
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'REFERENCE_NOT_FOUND'
  | 'INVALID_REFERENCE'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'INVALID_MONEY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_TRANSACTION_STATE'
  | 'INVALID_PAYLOAD'
  | 'IDEMPOTENCY_CONFLICT'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_MISMATCH';

export class DomainError extends Error {
  constructor(public readonly code: FailureCode, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
