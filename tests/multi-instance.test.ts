import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

// Roda exclusivamente com `bun run test:multi` e tres instancias do Docker Compose.
const HOSTS = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
const it = process.env.TEST_MULTI_INSTANCE === '1' ? test : test.skip;

type Wallet = { id: string; playerId: string; version: number; balance: { amount: string; currency: string } };
type Receipt = {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
};
type Response<T> = { status: number; body: T };

async function json<T>(url: string, opts?: RequestInit): Promise<Response<T>> {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  return { status: res.status, body: await res.json() as T };
}
async function post<T>(instance: number, path: string, body: object, key?: string): Promise<Response<T>> {
  return json<T>(`${HOSTS[instance]}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
}
async function createWallet(instance: number, initialBalance = '100.00'): Promise<Wallet> {
  const created = await post<Wallet>(instance, '/wallets', {
    playerId: randomUUID(), initialBalance: { amount: initialBalance, currency: 'BRL' },
  });
  expect(created.status).toBe(201);
  return created.body;
}
function bet(wallet: Wallet, externalTransactionId: string, amount: string): object {
  return {
    providerId: 'multi-instance-test', externalTransactionId,
    playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'race-round', gameId: 'race-game', kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}
async function assertWallet(instance: number, wallet: Wallet, expectedBalance: string, expectedEntries: number) {
  const current = await json<Wallet>(`${HOSTS[instance]}/wallets/${wallet.id}`);
  expect(current.status).toBe(200);
  expect(current.body.balance).toEqual({ amount: expectedBalance, currency: 'BRL' });
  const rec = await post<{ consistent: boolean; checkedEntries: number; difference: { amount: string } }>(
    instance, `/wallets/${wallet.id}/reconciliation`, {},
  );
  expect(rec.status).toBe(201);
  expect(rec.body.consistent).toBe(true);
  expect(rec.body.checkedEntries).toBe(expectedEntries);
  expect(rec.body.difference.amount).toBe('0.00');
  return current.body;
}

it('os tres processos HTTP respondem e compartilham PostgreSQL e SQS', async () => {
  const ready = await Promise.all(HOSTS.map(host => json<{ status: string }>(`${host}/health/ready`)));
  for (const response of ready) {
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
  }
}, 20000);

it('50 reentregas distribuidas entre 3 processos causam um unico debito', async () => {
  const wallet = await createWallet(0);
  const external = randomUUID();
  const requests = Array.from({ length: 50 }, (_, n) =>
    post<Receipt>(n % HOSTS.length, '/wagering/transactions', bet(wallet, external, '10.00'), `multi:${external}`),
  );
  const responses = await Promise.all(requests);
  expect(responses.every(response => response.status === 201)).toBe(true);
  expect(responses.every(response => response.body.status === 'PROCESSED')).toBe(true);
  expect(responses.filter(response => !response.body.idempotentReplay)).toHaveLength(1);
  expect(new Set(responses.map(response => response.body.transactionId)).size).toBe(1);
  const current = await assertWallet(2, wallet, '90.00', 2);
  expect(current.version).toBe(2);
}, 45000);

it('duas apostas de 80 em processos distintos disputam os mesmos 100', async () => {
  const wallet = await createWallet(0);
  const one = randomUUID();
  const two = randomUUID();
  const responses = await Promise.all([
    post<Receipt>(1, '/wagering/transactions', bet(wallet, one, '80.00'), `multi:${one}`),
    post<Receipt>(2, '/wagering/transactions', bet(wallet, two, '80.00'), `multi:${two}`),
  ]);
  expect(responses.map(r => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(responses.find(r => r.body.status === 'REJECTED')?.status).toBe(422);
  expect(responses.find(r => r.body.status === 'REJECTED')?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  const current = await assertWallet(0, wallet, '20.00', 2);
  expect(current.version).toBe(2);
}, 30000);

it('12 apostas diferentes sobre a mesma wallet respeitam o lock por wallet', async () => {
  const wallet = await createWallet(0);
  const requests = Array.from({ length: 12 }, (_, i) => {
    const external = randomUUID();
    return post<Receipt>(i % HOSTS.length, '/wagering/transactions', bet(wallet, external, '20.00'), `multi:${external}`);
  });
  const results = await Promise.all(requests);
  expect(results.filter(r => r.body.status === 'PROCESSED')).toHaveLength(5);
  expect(results.filter(r => r.body.status === 'REJECTED')).toHaveLength(7);
  const current = await assertWallet(1, wallet, '0.00', 6);
  expect(current.version).toBe(6);
}, 30000);

it('wallets independentes processam apostas em paralelo entre os 3 processos', async () => {
  const wallets = await Promise.all(HOSTS.map((_, i) => createWallet(i)));
  const responses = await Promise.all(wallets.map((w, i) => {
    const external = randomUUID();
    return post<Receipt>(i, '/wagering/transactions', bet(w, external, '25.00'), `multi:${external}`);
  }));
  expect(responses.every(r => r.status === 201 && r.body.status === 'PROCESSED')).toBe(true);
  await Promise.all(wallets.map((w, i) => assertWallet(i, w, '75.00', 2)));
}, 25000);
