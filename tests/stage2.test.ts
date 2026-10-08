import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const BASE = process.env.TEST_BASE_URL;
const it = BASE ? test : test.skip;
const player = () => randomUUID();
async function post(path: string, body: object, key?: string) {
  const response = await fetch(`${BASE}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
async function wallet(balance: string) {
  const result = await post('/wallets', { playerId: player(),
    initialBalance: { amount: balance, currency: 'BRL' } });
  expect(result.status).toBe(201);
  return result.body;
}
function wager(w: any, kind: string, amount: string, external: string, ref?: string) {
  return { providerId: 'provider-test', playerId: w.playerId, walletId: w.id,
    externalTransactionId: external, roundId: 'round-one', gameId: 'game-one', kind,
    money: { amount, currency: 'BRL' },
    ...(ref ? { referenceExternalTransactionId: ref } : {}) };
}
async function submit(w: any, kind: string, amount: string, external: string, ref?: string) {
  return post('/wagering/transactions', wager(w, kind, amount, external, ref), `test:${external}`);
}
async function readWallet(w: any) {
  return (await (await fetch(`${BASE}/wallets/${w.id}`)).json()) as any;
}
async function reconcile(w: any) {
  return (await post(`/wallets/${w.id}/reconciliation`, {})).body;
}
async function until(check: () => Promise<boolean>, ms = 14000) {
  const untilAt = Date.now() + ms;
  while (Date.now() < untilAt) {
    if (await check()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

it('REFUND aplica apenas uma vez, segundo refund é rejeitado e ledger reconcilia', async () => {
  const w = await wallet('100.00');
  const id = randomUUID();
  expect((await submit(w, 'BET', '40.00', id)).status).toBe(201);
  const first = await submit(w, 'REFUND', '40.00', randomUUID(), id);
  expect(first.body.status).toBe('PROCESSED');
  const second = await submit(w, 'REFUND', '40.00', randomUUID(), id);
  expect(second.status).toBe(422);
  expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  expect((await readWallet(w)).balance.amount).toBe('100.00');
  expect((await reconcile(w)).checkedEntries).toBe(3);
  expect((await reconcile(w)).consistent).toBe(true);
}, 15000);

it('ROLLBACK de WIN rejeita débito que tornaria o saldo negativo', async () => {
  const w = await wallet('10.00');
  const win = randomUUID();
  expect((await submit(w, 'WIN', '30.00', win)).status).toBe(201);
  expect((await submit(w, 'BET', '35.00', randomUUID())).status).toBe(201);
  const r = await submit(w, 'ROLLBACK', '30.00', randomUUID(), win);
  expect(r.status).toBe(422);
  expect(r.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  expect((await readWallet(w)).balance.amount).toBe('5.00');
  expect((await reconcile(w)).consistent).toBe(true);
}, 15000);

it('ROLLBACK fora de ordem fica pendente e é aplicado após BET referenciada', async () => {
  const w = await wallet('100.00');
  const betId = randomUUID();
  const rollbackId = randomUUID();
  const rollback = await submit(w, 'ROLLBACK', '20.00', rollbackId, betId);
  expect(rollback.status).toBe(202);
  expect(rollback.body.status).toBe('PENDING_REFERENCE');
  const bet = await submit(w, 'BET', '20.00', betId);
  expect(bet.status).toBe(201);
  const processed = await until(async () => {
    const response = await fetch(`${BASE}/wagering/transactions/${rollback.body.transactionId}`);
    const data: any = await response.json();
    return data.status === 'PROCESSED';
  });
  expect(processed).toBe(true);
  expect((await readWallet(w)).balance.amount).toBe('100.00');
  expect((await reconcile(w)).checkedEntries).toBe(3);
  expect((await reconcile(w)).consistent).toBe(true);
}, 20000);

it('SQS grava inbox, consome BET e suporta redelivery sem débito duplicado', async () => {
  const w = await wallet('100.00');
  const external = randomUUID();
  const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  try {
    const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }))).QueueUrl!;
    const parsed = new URL(queueUrl);
    parsed.protocol = 'http:'; parsed.host = 'localhost:4566';
    const url = parsed.toString();
    const body = JSON.stringify({ messageId: randomUUID(), type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(), data: {
        ...wager(w, 'BET', '10.00', external), idempotencyKey: `test:${external}`,
      } });
    await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body,
      MessageGroupId: w.id, MessageDeduplicationId: randomUUID() }));
    expect(await until(async () => (await readWallet(w)).balance.amount === '90.00')).toBe(true);
    await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body,
      MessageGroupId: w.id, MessageDeduplicationId: randomUUID() }));
    await new Promise(r => setTimeout(r, 1200));
    expect((await readWallet(w)).balance.amount).toBe('90.00');
    expect((await reconcile(w)).checkedEntries).toBe(2);
    expect((await reconcile(w)).consistent).toBe(true);
  } finally { sqs.destroy(); }
}, 25000);
