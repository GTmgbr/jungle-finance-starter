import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';


const it = process.env.TEST_RECOVERY === '1' ? test : test.skip;
const HOSTS = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type Wallet = { id: string; playerId: string; version: number; balance: { amount: string; currency: string } };
type Receipt = {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
};

function docker(...args: string[]) {
  const r = spawnSync('docker', ['compose', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} falhou: ${r.error?.message ?? r.stderr}`);
  }
  return r.stdout.trim();
}

function sql(query: string): string {
  return docker('exec', '-T', 'postgres', 'psql', '-X', '-U', 'jungle', '-d', 'jungle_finance',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', query);
}

function sqlShouldFail(query: string, expectedError: RegExp): void {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-X',
    '-U', 'jungle', '-d', 'jungle_finance', '-v', 'ON_ERROR_STOP=1', '-c', query],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
  if (r.error) throw r.error;
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(expectedError);
}

async function request<T>(url: string, options?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json() as T };
}
async function post<T>(instance: number, path: string, body: object, key?: string) {
  return request<T>(`${HOSTS[instance]}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body),
  });
}
async function createWallet(initial = '100.00'): Promise<Wallet> {
  const created = await post<Wallet>(0, '/wallets', {
    playerId: randomUUID(), initialBalance: { amount: initial, currency: 'BRL' },
  });
  expect(created.status).toBe(201);
  return created.body;
}
function bet(wallet: Wallet, externalTransactionId: string, amount = '20.00') {
  return { providerId: 'resilience-test', externalTransactionId, walletId: wallet.id,
    playerId: wallet.playerId, roundId: 'test-round', gameId: 'test-game', kind: 'BET',
    money: { amount, currency: 'BRL' } };
}
async function current(wallet: Wallet, instance = 0): Promise<Wallet> {
  const result = await request<Wallet>(`${HOSTS[instance]}/wallets/${wallet.id}`);
  expect(result.status).toBe(200);
  return result.body;
}
async function reconciliation(wallet: Wallet, instance = 0) {
  const r = await post<{ consistent: boolean; checkedEntries: number; difference: { amount: string } }>(
    instance, `/wallets/${wallet.id}/reconciliation`, {},
  );
  expect(r.status).toBe(201);
  expect(r.body.consistent).toBe(true);
  expect(r.body.difference.amount).toBe('0.00');
  return r.body;
}
async function until(fn: () => Promise<boolean>, timeout = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await fn()) return true; } catch { /* serviços podem estar reiniciando */ }
    await wait(300);
  }
  return false;
}
async function allReady() {
  return until(async () => {
    const results = await Promise.all(HOSTS.map(h => request<{ status: string }>(`${h}/health/ready`)));
    return results.every(r => r.status === 200 && r.body.status === 'ready');
  }, 30_000);
}
const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 2 });
async function queue(name: string) {
  const found = (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl;
  if (!found) throw new Error(`Fila não encontrada: ${name}`);
  const url = new URL(found);
  url.protocol = 'http:';
  url.host = 'localhost:4566';
  return url.toString();
}
async function sendMain(body: string, group: string) {
  await sqs.send(new SendMessageCommand({ QueueUrl: await queue('wager-transactions.fifo'),
    MessageBody: body, MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
}

it('constraints do banco proíbem saldo negativo e qualquer mudança no ledger', async () => {
  const wallet = await createWallet();
  const ledgerId = sql(`SELECT id FROM wallet_ledger_entries WHERE wallet_id='${wallet.id}' LIMIT 1`);
  expect(ledgerId).toBeTruthy();
  sqlShouldFail(`UPDATE wallets SET balance=-1 WHERE id='${wallet.id}'`, /check constraint/i);
  sqlShouldFail(`UPDATE wallet_ledger_entries SET amount=0 WHERE id='${ledgerId}'`, /ledger_entries is immutable/i);
  sqlShouldFail(`DELETE FROM wallet_ledger_entries WHERE id='${ledgerId}'`, /ledger_entries is immutable/i);
  expect((await current(wallet)).balance.amount).toBe('100.00');
  expect((await reconciliation(wallet)).checkedEntries).toBe(1);
}, 30_000);

it('tres publishers recuperam evento de outbox com lease expirado', async () => {
  expect(await allReady()).toBe(true);
  const wallet = await createWallet('0.00');
  const eventId = randomUUID();
  const owner = randomUUID();
  //Evento de diagnostico isolado: nao altera saldo nem ledger.
  const envelope = { eventId, eventType: 'RecoveryProbe', aggregateId: wallet.id,
    correlationId: eventId, occurredAt: new Date().toISOString(), version: 1, data: { probeId: eventId } };
  const encoded = JSON.stringify(envelope).replaceAll("'", "''");
  sql(`INSERT INTO outbox_messages
    (id, aggregate_id, event_type, payload, occurred_at, attempts, locked_until, lock_owner)
    VALUES ('${eventId}', '${wallet.id}', 'RecoveryProbe', '${encoded}'::jsonb,
      now(), 0, now() + interval '3 seconds', '${owner}')`);
  expect(await until(async () => sql(`SELECT CASE WHEN published_at IS NOT NULL
    AND lock_owner IS NULL THEN 'yes' ELSE 'no' END
    FROM outbox_messages WHERE id='${eventId}'`) === 'yes', 20_000)).toBe(true);
  expect(sql(`SELECT count(*) FROM outbox_messages WHERE id='${eventId}'`)).toBe('1');
}, 30_000);

it('reinicio das 3 instancias preserva saldo, ledger e resposta idempotente', async () => {
  const wallet = await createWallet();
  const external = randomUUID();
  const idempotencyKey = `recovery:${external}`;
  const payload = bet(wallet, external);
  const first = await post<Receipt>(0, '/wagering/transactions', payload, idempotencyKey);
  expect(first.status).toBe(201);
  expect(first.body.status).toBe('PROCESSED');
  try {
    docker('restart', 'api', 'api2', 'api3');
    expect(await allReady()).toBe(true);
    const replay = await post<Receipt>(2, '/wagering/transactions', payload, idempotencyKey);
    expect(replay.status).toBe(201);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.balance.amount).toBe('80.00');
    expect((await current(wallet, 1)).version).toBe(2);
    expect((await reconciliation(wallet, 2)).checkedEntries).toBe(2);
  } finally {
    //Em caso de falha durante o teste, garantir que o ambiente volta a funcionar
    docker('start', 'api', 'api2', 'api3');
  }
}, 75_000);

it('mensagem SQS enviada sem workers sobrevive e é processada após retomada', async () => {
  const wallet = await createWallet();
  const external = randomUUID();
  const messageId = randomUUID();
  const messageBody = JSON.stringify({ messageId, type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(), data: {
      ...bet(wallet, external, '15.00'), idempotencyKey: `recovery:${external}`,
    } });
  try {
    docker('stop', 'api', 'api2', 'api3');
    await sendMain(messageBody, wallet.id);
    docker('start', 'api', 'api2', 'api3');
    expect(await allReady()).toBe(true);
    expect(await until(async () => (await current(wallet)).balance.amount === '85.00')).toBe(true);
    await sendMain(messageBody, wallet.id); // reentrega sem novo debito
    expect(await until(async () => sql(`SELECT count(*) FROM inbox_messages
      WHERE consumer_name='wager-transactions-v1' AND message_id='${messageId}'`) === '1')).toBe(true);
    await wait(1500);
    expect((await current(wallet, 2)).balance.amount).toBe('85.00');
    expect((await reconciliation(wallet, 1)).checkedEntries).toBe(2);
  } finally {
    docker('start', 'api', 'api2', 'api3');
  }
}, 90_000);

it('mensagem invalida vai para DLQ sem contaminar o ledger', async () => {
  const unique = randomUUID();
  const body = JSON.stringify({ messageId: unique, type: 'UnknownType', data: {} });
  await sendMain(body, unique);
  const dlq = await queue('wager-transactions-dlq.fifo');
  let found = false;
  const started = Date.now();
  while (!found && Date.now() - started < 20_000) {
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq,
      MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 2 }));
    for (const message of received.Messages ?? []) {
      if (message.Body === body && message.ReceiptHandle) {
        found = true;
        await sqs.send(new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: message.ReceiptHandle }));
        break;
      }
    }
    if (!found) await wait(250);
  }
  expect(found).toBe(true);
  expect(sql(`SELECT count(*) FROM inbox_messages WHERE message_id='${unique}'`)).toBe('0');
}, 30_000);
