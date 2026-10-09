# Jungle Finance 

NestJS + TypeScript strict + Bun 1.x + TypeORM + PostgreSQL + SQS (LocalStack).

**Estado verificado (10/out/2026):** foram executados com sucesso 24 testes: 7 unitários (incluindo observabilidade), 7 de integração financeira/SQS, 5 com três instâncias concorrentes e 5 de recuperação. O endpoint `/metrics` respondeu e o `bun run typecheck` terminou sem erros. Em uma consulta operacional, a outbox teve 128 eventos publicados e 0 pendentes após recuperação de falhas. 

## Pré-requisitos

- Docker Engine / Docker Desktop com Docker Compose v2.
- Bun 1.x para executar os testes localmente. O servidor também roda inteiramente em Docker (Bun já incluído na imagem).
- Portas livres: 3000, 5433, 4566 (também 3001/3002 para modo concorrência).

## Subir o projeto

No terminal: 

docker compose up -d --build
docker compose ps
docker compose logs -f api

> `migrate` executa uma única vez antes de iniciar `api`; as migrations não são disparadas por cada réplica.

Verificar:

No terminal:

curl http://localhost:3000/health/live

curl http://localhost:3000/health/ready

O primeiro retorna `{"status":"ok"}`. Readiness requer o PostgreSQL e a fila SQS inicializada, podendo responder `503` até LocalStack terminar o hook.

## Fluxo de demonstração

**1. Criar wallet com R$ 100 (gera OPENING + lançamento CREDIT).**

No terminal:

curl -s -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

Copiar o `id` retornado e usar nos exemplos seguintes como `WALLET_UUID`.

**2. Apostar R$ 80.**

No terminal:

curl -i -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-001","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_UUID","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'

Repetir exatamente a mesma requisição produz o mesmo `transactionId`, o saldo observado na primeira execução e `idempotentReplay: true`. Se o valor for alterado, e a key for mantida, produzirá `409 IDEMPOTENCY_CONFLICT`.

**3. Consultar wallet, ledger e reconciliação.**

No terminal:

curl http://localhost:3000/wallets/WALLET_UUID
curl 'http://localhost:3000/wallets/WALLET_UUID/ledger?limit=50'
curl -X POST http://localhost:3000/wallets/WALLET_UUID/reconciliation

A reconciliação usa uma única fotografia transacional (`REPEATABLE READ`).

##Rodar testes

Com Bun 1.x instalado:

No terminal:

bun install
bun test

Com a API e PostgreSQL reais levantados via Compose:

No terminal:

bun run test:integration

Os testes de integração HTTP executam apostas concorrentes e repetidas. Para iniciar três processos de API distintos usando a mesma wallet e a mesma base:

No terminal:

docker compose --profile concurrency up -d --build
curl http://localhost:3001/health/live
curl http://localhost:3002/health/live

Executar concorrência efetivamente distribuída e recuperação em comandos separados:

No terminal:

bun run test:multi
bun run test:recovery

O `test:recovery` interrompe temporariamente e reinicia os containers da aplicação; não se deve executar em paralelo a outras suítes. Também nunca deve-se usar `docker compose down -v` para testar recuperação, pois ele apaga os dados.

###Métricas

Com os serviços ativos:

No terminal:

curl -fsS http://localhost:3000/metrics
curl -fsS http://localhost:3001/metrics
curl -fsS http://localhost:3002/metrics

`/metrics` expõe formato Prometheus, sem dependências adicionais. Contagens de transações por status, eventos da outbox e lag vêm do PostgreSQL. A profundidade estimada da DLQ vem do SQS. Replays, conflitos de lock, retries observados e latência são locais a cada processo e reiniciam com o container. Coletar as três instâncias para interpretar o total. Os valores SQL são repetidos entre réplicas: não somar esses gauges ao agregá-los.

##Migrations

A migration inicial está em `src/database/migrations/2026100700000-InitialSchema.ts` e implementa `up` e `down`.

```bash
# Após editar migrations, reconstrua a imagem:
docker compose build migrate
# Aplicar migrations (normalmente automático no up):
docker compose run --rm migrate
# Reverter a última migration (DESTRUTIVO, executar somente em ambiente descartável):
docker compose run --rm migrate bun dist/database/revert.js
```

**Nunca use `synchronize: true`.**

## Parar e limpar

```bash
docker compose down
# ATENÇÃO: remove também o volume e os saldos gravados
docker compose down -v
```

## API HTTP

| Endpoint | Comportamento atual |
|---|---|
| `POST /wallets` | Cria wallet; gera OPENING e ledger se saldo inicial > 0 |
| `GET /wallets/:walletId` | Consulta saldo e versão |
| `GET /wallets/:walletId/ledger` | Cursor base64url opaco e ordem estável |
| `POST /wallets/:walletId/reconciliation` | Saldo persistido vs somatório ledger |
| `POST /wagering/transactions` | BET/WIN/LOSS/REFUND/ROLLBACK, referências pendentes, idempotência e locks |
| `GET /wagering/transactions/:id` | Consulta interna |
| `GET /providers/:providerId/wagering/transactions/:externalId` | Consulta por chave do provedor |
| `GET /health/live` | Liveness |
| `GET /health/ready` | PostgreSQL e SQS |

Regras de status: `400` payload inválido, `404` recurso ausente, `409` conflito, `422` transação rejeitada por saldo insuficiente, `503` falha temporária de infraestrutura. `201` transação processada (POST). REFUND/ROLLBACK são aceitos e podem retornar `201`, `202` ou `422`, conforme resultado.

## Evidências e escopo

A bateria executada no Linux Mint incluiu `bun run test`, `bun run test:integration`, `bun run test:multi` e `bun run test:recovery`, totalizando **24 testes aprovados e 0 falhas** na revisão de 8/out/2026. Os cenários incluem duas apostas competindo pelo mesmo saldo, 50 duplicatas distribuídas entre instâncias, reversões, inbox, SQS e recuperação de lease da outbox.

O relatório de arquitetura em [ARCHITECTURE.md](ARCHITECTURE.md) documenta as decisões, garantias, limitações e riscos ainda abertos.


## Limitações conhecidas e priorização de entrega

- Autenticação deliberadamente omitida, por ser aceita sem pontos; `NoopAuthGuard` é extensão explícita, não proteção real.
- Retentativas e deduplicação são garantidas no PostgreSQL; SQS FIFO melhora a operação, mas não fornece exatamente-uma-vez de ponta a ponta.
- A outbox faz entrega **ao menos uma vez**: após publicar e antes de marcar `published_at`, um crash pode causar publicação repetida; consumidores devem deduplicar por `eventId`.
- O replay por mesma chave usada simultaneamente em wallets distintas ainda pode resultar em conflito de unicidade, documentado em ARCHITECTURE.md.
- Não foram executados todos os cenários destrutivos de falha injetada exatamente entre commit/ACK nem carga com medidas p50/p95/p99 sob ambiente controlado.
- O banco e os volumes persistem entre reinícios: nunca use `down -v` sem intenção explícita de apagar saldos.
- Após `bun install`, **commitar o `bun.lock` gerado** para tornar o build reproduzível.
