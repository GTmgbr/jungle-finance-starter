import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema2026100700000 implements MigrationInterface {
  name = 'InitialSchema2026100700000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance NUMERIC(20,2) NOT NULL CHECK (balance >= 0),
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(player_id, currency)
      )
    `);
    await q.query(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(200) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL UNIQUE,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(200) NOT NULL,
        game_id VARCHAR(200) NOT NULL,
        kind VARCHAR(15) NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),
        currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id VARCHAR(200),
        reference_transaction_id UUID REFERENCES wager_transactions(id),
        status VARCHAR(25) NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code VARCHAR(80),
        result_balance NUMERIC(20,2) CHECK (result_balance >= 0),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,
        UNIQUE(provider_id, external_transaction_id),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CHECK (status NOT IN ('PROCESSED','REJECTED') OR result_balance IS NOT NULL)
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX uq_reversal_per_kind
        ON wager_transactions (provider_id, reference_transaction_id, kind)
        WHERE reference_transaction_id IS NOT NULL AND kind IN ('REFUND','ROLLBACK')
    `);
    await q.query(`
      CREATE INDEX idx_pending_reference ON wager_transactions(next_attempt_at, created_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
    await q.query(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL UNIQUE REFERENCES wager_transactions(id),
        direction VARCHAR(6) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after NUMERIC(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after)
          OR (direction = 'DEBIT' AND balance_before - amount = balance_after)
        )
      )
    `);
    await q.query(`
      CREATE INDEX idx_ledger_wallet_order ON wallet_ledger_entries (wallet_id, created_at, id)
    `);
    await q.query(`
      CREATE FUNCTION forbid_ledger_changes() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable';
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(`
      CREATE TRIGGER immutable_ledger_rows BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION forbid_ledger_changes()
    `);
    await q.query(`
      CREATE TRIGGER immutable_ledger_truncate BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_changes()
    `);
    await q.query(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(200) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);
    await q.query(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        locked_until TIMESTAMPTZ,
        lock_owner UUID
      )
    `);
    await q.query(`
      CREATE INDEX idx_outbox_due ON outbox_messages (next_attempt_at, occurred_at)
      WHERE published_at IS NULL
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS outbox_messages');
    await q.query('DROP TABLE IF EXISTS inbox_messages');
    await q.query('DROP TABLE IF EXISTS wallet_ledger_entries');
    await q.query('DROP FUNCTION IF EXISTS forbid_ledger_changes()');
    await q.query('DROP TABLE IF EXISTS wager_transactions');
    await q.query('DROP TABLE IF EXISTS wallets');
  }
}
