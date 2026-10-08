import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { WalletsService } from './wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly service: WalletsService) {}
  @Post()
  create(@Body() body: unknown) { return this.service.create(body); }
  @Get(':walletId')
  get(@Param('walletId') walletId: string) { return this.service.get(walletId); }
  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string,
         @Query('limit') limit?: string) { return this.service.ledger(walletId, cursor, limit); }
  @Post(':walletId/reconciliation')
  reconcile(@Param('walletId') walletId: string) { return this.service.reconcile(walletId); }
}
