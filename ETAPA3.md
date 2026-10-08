# Etapa 3 — Evidencia de multiplas instancias (incremental)

Este patch adiciona somente testes e um script no `package.json`; **nenhuma tabela ou regra financeira e alterada**.

## Rodar

```bash
# Na raiz do projeto, com Docker funcionando
bun install
bun run typecheck
# O Compose da etapa 2 ja define api2 e api3 no profile concurrency.
docker compose --profile concurrency up -d --build
docker compose --profile concurrency ps -a
curl -fsS http://localhost:3000/health/ready
curl -fsS http://localhost:3001/health/ready
curl -fsS http://localhost:3002/health/ready
bun run test:multi
```

**Esperado:** 5 testes passando, 0 falhas. Os testes usam jogadores, wallets e IDs externos novos; nao apagam nem alteram wallets antigas.

Os cinco cenarios exercitam tres **processos reais** e um PostgreSQL compartilhado:
1. health/ready nos tres;
2. a mesma aposta enviada 50 vezes para os tres;
3. duas apostas de 80 competindo por saldo 100 a partir de processos distintos;
4. 12 apostas diferentes numa mesma wallet (5 aceitas, 7 rejeitadas);
5. wallets independentes em paralelo.

## Verificar outbox e consistencia apos os testes

```bash
docker compose exec -T postgres psql -U jungle -d jungle_finance -c \
  "SELECT count(*) AS unpublished FROM outbox_messages WHERE published_at IS NULL;"
docker compose exec -T postgres psql -U jungle -d jungle_finance -c \
  "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='PROCESSED') AS processed, COUNT(*) FILTER (WHERE status='REJECTED') AS rejected FROM wager_transactions;"
```

A outbox pode demorar um pouco para esvaziar; aguarde alguns segundos e repita a consulta. Um outbox vazio NAO prova ausencia de duplicidade de publicacao, apenas que nao ha eventos por publicar.

Para parar as duas instancias extras mantendo banco e dados:

```bash
docker compose --profile concurrency stop api2 api3
```

**Nao execute** `docker compose down -v`, que remove o volume e os dados.

## Limitacoes / proximos testes

Estes testes demonstram concorrencia HTTP multi-processo, mas ainda nao simulam morte do worker exatamente entre COMMIT e ACK, nem publicacao duplicada apos COMMIT seguida de falha no publisher. Esses cenarios exigem falhas injetadas com controle do ponto de parada e devem ser testados a parte, sem afirmar que estao cobertos.
