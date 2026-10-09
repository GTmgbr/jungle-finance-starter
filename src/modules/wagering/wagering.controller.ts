import { Body, Controller, Get, Headers, HttpException, Param, Post } from '@nestjs/common';
import { WageringService, WagerReceipt } from './wagering.service';

@Controller()
export class WageringController {
  constructor(private readonly service: WageringService) {}

  @Post('wagering/transactions')
  async submit(@Body() body: unknown, @Headers('idempotency-key') key?: string): Promise<WagerReceipt> {
    const result = await this.service.submit(body, key);
    //O commit já confirmado. Business reject = 422; replay mantém o mesmo status HTTP.
    if (result.status === 'REJECTED') throw new HttpException(result, 422);
    if (result.status === 'PENDING_REFERENCE' || result.status === 'PENDING') {
      throw new HttpException(result, 202);
    }
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  getById(@Param('transactionId') id: string) { return this.service.getById(id); }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternal(@Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string) {
    return this.service.getByExternal(providerId, externalId);
  }
}
