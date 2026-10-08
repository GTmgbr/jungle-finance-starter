import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../domain/errors';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const raw = error.getResponse();
      response.status(error.getStatus()).json(typeof raw === 'string' ? { error: raw } : raw);
      return;
    }
    if (error instanceof DomainError) {
      const code = error.code === 'IDEMPOTENCY_CONFLICT' ? HttpStatus.CONFLICT
        : error.code === 'WALLET_NOT_FOUND' ? HttpStatus.NOT_FOUND
        : ['INVALID_MONEY', 'INVALID_PAYLOAD'].includes(error.code) ? HttpStatus.BAD_REQUEST
        : HttpStatus.UNPROCESSABLE_ENTITY;
      response.status(code).json({ code: error.code, message: error.message });
      return;
    }
    const pgCode = (error as { code?: string } | null)?.code;
    if (pgCode === '23505') {
      response.status(409).json({ code: 'DUPLICATE_RESOURCE', message: 'Recurso já existente.' });
      return;
    }
    console.error(JSON.stringify({ level: 'error', event: 'unhandled_exception',
      errorType: error instanceof Error ? error.name : 'unknown' }));
    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      code: 'INFRASTRUCTURE_UNAVAILABLE', message: 'Falha temporária. Reenvio permitido.',
    });
  }
}
