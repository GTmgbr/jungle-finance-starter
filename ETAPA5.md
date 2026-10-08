# Etapa 5 — Observabilidade mínima e documentação

Esta atualização **não modifica** `Money`, `Wallet`, ledger, migrations, idempotência ou regras de aposta. Acrescenta métricas e atualiza README/ARCHITECTURE.

## Instalar

Na pasta do projeto, após salvar um backup:

```bash
unzip -o "$HOME/Downloads/jungle-finance-etapa5-observabilidade.zip" -d .
bun run typecheck
bun run test
```

Se não houver erros, faça o rebuild dos três containers:

```bash
docker compose --profile concurrency up -d --build
curl -fsS http://localhost:3000/metrics
curl -fsS http://localhost:3001/metrics
curl -fsS http://localhost:3002/metrics
```

## Conferir regressões

```bash
bun run test:integration
bun run test:multi
bun run test:recovery
```

Execute a suíte de recuperação **por último**, separada das demais: ela reinicia as APIs.

## Métricas disponíveis

- `jungle_wager_transactions{status}`: contagem SQL por estado atual.
- `jungle_outbox_pending`, `jungle_outbox_published`, `jungle_outbox_retried_events`, `jungle_outbox_oldest_pending_seconds`: SQL.
- `jungle_dlq_depth`: contagem aproximada, obtida do SQS; omitida quando inacessível.
- `jungle_dlq_metrics_available`: 1 se a consulta SQS funcionou; 0 caso contrário.
- `jungle_idempotent_replays_total`, `jungle_outbox_retries_total`, `jungle_sqs_retries_total`, `jungle_reference_retries_total`, `jungle_dlq_sent_total`, `jungle_lock_conflicts_total`, `jungle_reconciliation_mismatches_total`: contadores locais ao processo.
- `jungle_wager_processing_seconds`: histograma de latência, local ao processo.

**Limitação:** métricas locais zeram ao reiniciar; SQL representa estado compartilhado, logo não deve ser somado entre réplicas. Em produção, seria necessária coleta externa com Prometheus/OTel, identificação das instâncias e controle de acesso.

**Não execute** `docker compose down -v`.
