import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'wallets' })
export class WalletRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'player_id', type: 'uuid' }) playerId!: string;
  @Column({ type: 'varchar', length: 3 }) currency!: string;
  @Column({ type: 'numeric', precision: 20, scale: 2 }) balance!: string;
  @Column({ type: 'integer' }) version!: number;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

@Entity({ name: 'wager_transactions' })
export class WagerRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'provider_id', type: 'varchar', length: 100 }) providerId!: string;
  @Column({ name: 'external_transaction_id', type: 'varchar', length: 200 }) externalTransactionId!: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 }) idempotencyKey!: string;
  @Column({ name: 'payload_hash', type: 'char', length: 64 }) payloadHash!: string;
  @Column({ name: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Column({ name: 'player_id', type: 'uuid' }) playerId!: string;
  @Column({ name: 'round_id', type: 'varchar', length: 200 }) roundId!: string;
  @Column({ name: 'game_id', type: 'varchar', length: 200 }) gameId!: string;
  @Column({ type: 'varchar', length: 15 }) kind!: string;
  @Column({ type: 'numeric', precision: 20, scale: 2 }) amount!: string;
  @Column({ type: 'varchar', length: 3 }) currency!: string;
  @Column({ name: 'reference_external_transaction_id', type: 'varchar', length: 200, nullable: true })
  referenceExternalTransactionId!: string | null;
  @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true }) referenceTransactionId!: string | null;
  @Column({ type: 'varchar', length: 25 }) status!: string;
  @Column({ name: 'failure_code', type: 'varchar', length: 80, nullable: true }) failureCode!: string | null;
  @Column({ name: 'result_balance', type: 'numeric', precision: 20, scale: 2, nullable: true })
  resultBalance!: string | null;
  @Column({ name: 'attempts', type: 'integer' }) attempts!: number;
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true }) nextAttemptAt!: Date | null;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true }) processedAt!: Date | null;
}

@Entity({ name: 'wallet_ledger_entries' })
export class LedgerRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Column({ name: 'transaction_id', type: 'uuid' }) transactionId!: string;
  @Column({ type: 'varchar', length: 6 }) direction!: string;
  @Column({ type: 'numeric', precision: 20, scale: 2 }) amount!: string;
  @Column({ type: 'varchar', length: 3 }) currency!: string;
  @Column({ name: 'balance_before', type: 'numeric', precision: 20, scale: 2 }) balanceBefore!: string;
  @Column({ name: 'balance_after', type: 'numeric', precision: 20, scale: 2 }) balanceAfter!: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity({ name: 'inbox_messages' })
export class InboxRecord {
  @PrimaryColumn({ name: 'consumer_name', type: 'varchar', length: 100 }) consumerName!: string;
  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 200 }) messageId!: string;
  @Column({ name: 'payload_hash', type: 'char', length: 64 }) payloadHash!: string;
  @Column({ name: 'received_at', type: 'timestamptz' }) receivedAt!: Date;
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true }) processedAt!: Date | null;
}

@Entity({ name: 'outbox_messages' })
export class OutboxRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
  @Column({ name: 'event_type', type: 'varchar', length: 100 }) eventType!: string;
  @Column({ type: 'jsonb' }) payload!: object;
  @Column({ name: 'occurred_at', type: 'timestamptz' }) occurredAt!: Date;
  @Column({ type: 'integer' }) attempts!: number;
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true }) nextAttemptAt!: Date | null;
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt!: Date | null;
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true }) lockedUntil!: Date | null;
  @Column({ name: 'lock_owner', type: 'uuid', nullable: true }) lockOwner!: string | null;
}
