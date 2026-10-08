import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

const BASE = process.env.TEST_BASE_URL;
const it = BASE ? test : test.skip;

async function post(path: string, body: object, key?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function wallet(initial: string): Promise<any> {
  const r = await post('/wallets', { playerId: randomUUID(), initialBalance: { amount: initial, currency: 'BRL' } });
  expect(r.status).toBe(201);
  return r.body;
}
function bet(w: any, external: string, amount: string) {
  return { providerId: 'provider-a', externalTransactionId: external,
    walletId: w.id, playerId: w.playerId, roundId: 'round-1', gameId: 'game-1',
    kind: 'BET', money: { amount, currency: 'BRL' } };
}

it('50 reentregas paralelas debitam a wallet uma única vez (PostgreSQL real)', async () => {
  const w = await wallet('100.00');
  const external = randomUUID();
  const requests = Array.from({ length: 50 }, () => post('/wagering/transactions', bet(w, external, '10.00'), `p:${external}`));
  const responses = await Promise.all(requests);
  expect(responses.every(r => r.status === 201)).toBe(true);
  expect(responses.filter(r => r.body.idempotentReplay === false)).toHaveLength(1);
  expect(new Set(responses.map(r => r.body.transactionId)).size).toBe(1);
  const current = await (await fetch(`${BASE}/wallets/${w.id}`)).json();
  expect(current.balance.amount).toBe('90.00');
  const reconciliation = await post(`/wallets/${w.id}/reconciliation`, {});
  expect(reconciliation.body.consistent).toBe(true);
  expect(reconciliation.body.checkedEntries).toBe(2); // OPENING + BET
}, 30000);

it('duas apostas de 80 sobre 100: uma aplicada, outra rejeitada', async () => {
  const w = await wallet('100.00');
  const a = randomUUID(), b = randomUUID();
  const results = await Promise.all([
    post('/wagering/transactions', bet(w, a, '80.00'), `p:${a}`),
    post('/wagering/transactions', bet(w, b, '80.00'), `p:${b}`),
  ]);
  expect(results.map(r => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(results.find(r => r.body.status === 'REJECTED')?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  const current = await (await fetch(`${BASE}/wallets/${w.id}`)).json();
  expect(current.balance.amount).toBe('20.00');
  const reconciliation = await post(`/wallets/${w.id}/reconciliation`, {});
  expect(reconciliation.body.consistent).toBe(true);
  expect(reconciliation.body.checkedEntries).toBe(2);
}, 15000);

it('mesma Idempotency-Key com payload diferente retorna conflito', async () => {
  const w = await wallet('100.00');
  const external = randomUUID();
  const key = `p:${external}`;
  expect((await post('/wagering/transactions', bet(w, external, '10.00'), key)).status).toBe(201);
  const conflict = await post('/wagering/transactions', bet(w, external, '15.00'), key);
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
}, 15000);
