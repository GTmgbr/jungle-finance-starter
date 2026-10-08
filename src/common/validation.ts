import { HttpException, HttpStatus } from '@nestjs/common';
import { DomainError } from '../domain/errors';
import { Money, MoneyProps } from '../domain/money';

export function requiredString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new DomainError('INVALID_PAYLOAD', `Campo ${field} inválido.`);
  }
  return value;
}
export function requiredUUID(value: unknown, field: string): string {
  const str = requiredString(value, field, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)) {
    throw new DomainError('INVALID_PAYLOAD', `${field} deve ser UUID.`);
  }
  return str;
}
export function parsedMoney(value: unknown): Money {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_MONEY', 'money precisa ser objeto.');
  }
  return Money.from(value as MoneyProps);
}
export function businessRejection(failureCode: string, payload: Record<string, unknown>): never {
  throw new HttpException({ ...payload, failureCode }, HttpStatus.UNPROCESSABLE_ENTITY);
}
