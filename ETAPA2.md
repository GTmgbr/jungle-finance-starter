# Etapa 2 — Reversões e Workers (incremental)

**Estado:** código preparado, mas **ainda não executado no Docker do candidato**. Mantenha os testes da etapa 1 e valide as novas integrações com `bun run typecheck`, `bun run test` e `bun run test:integration`.

## Instalação sem perder banco

1. **Não execute `docker compose down -v`** (apaga o volume PostgreSQL).
2. A atualização altera `src/modules/wagering/wagering.service.ts`, cria `src/workers/workers.service.ts`, registra o worker em `src/app.module.ts`, corrige o script `localstack/init-sqs.sh` e a porta local do postgres para 5433, altera dois tipos do campo JSONB, inclui testes e documentação. Nenhuma migration nova é necessária: a migration inicial já contém `inbox`, `outbox`, referência e índices.
3. Execute `bun install`, `bun run typecheck`, `bun run test`.
4. Suba com `docker compose up -d --build`, **sem** `-v`.
5. Execute `bun run test:integration`.

## Comportamento

- `POST /wagering/transactions`: BET, WIN, LOSS, REFUND e ROLLBACK.
- REFUND reverte somente BET; ROLLBACK inverte BET/WIN/REFUND.
- Referência identificada por `(providerId, referenceExternalTransactionId)` e validada por wallet/player/round/moeda. Valor integral para reversões.
- Reversão sem referência vira `PENDING_REFERENCE`, HTTP 202, com evento na outbox. O worker tenta de novo com backoff exponencial; **8 tentativas** (1s, 2s, 4s, 8s, 16s, 32s, 60s). Após esgotamento: `REJECTED/REFERENCE_NOT_FOUND`.
- Reversões que geram débito sem saldo: `REVERSAL_INSUFFICIENT_FUNDS`, enquanto BET rejeitada usa `INSUFFICIENT_FUNDS`.
- O schema e o lock `FOR UPDATE` por wallet protegem concorrência. Dois pedidos distintos do mesmo tipo de reversão da mesma referência: um é aplicado e o outro rejeitado.
- Consumidor SQS (`wager-transactions.fifo`) usa `WageringService.submit` com inbox persistida na mesma transação financeira. Exclui mensagem da fila só após commit. Erros transientes: não ack, redelivery SQS; mensagens inválidas: DLQ antes do ack. DLQ recebe também mensagens que atingem `maxReceiveCount=5`.
- Publisher outbox: claim com `FOR UPDATE SKIP LOCKED` + lease de 45s; eventos publicados em `wager-events.fifo`; marca `published_at` somente depois da confirmação de publicação. Publicação duplicada pode ocorrer após crash: o `eventId` permanece estável para consumidores deduplicarem.

## Teste manual — REFUND

Crie uma wallet com saldo 100.00 ou reutilize uma wallet já existente ajustando `WALLET_ID` e `PLAYER_ID`. Escolha IDs externos novos:

```bash
WALLET_ID='COLE-O-ID'
PLAYER_ID='COLE-O-PLAYER-ID'
curl -i -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo:bet-etapa2' \
  -d '{"providerId":"demo","externalTransactionId":"bet-etapa2","playerId":"'"$PLAYER_ID"'","walletId":"'"$WALLET_ID"'","roundId":"round-2","gameId":"game-1","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}'

curl -i -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo:refund-etapa2' \
  -d '{"providerId":"demo","externalTransactionId":"refund-etapa2","referenceExternalTransactionId":"bet-etapa2","playerId":"'"$PLAYER_ID"'","walletId":"'"$WALLET_ID"'","roundId":"round-2","gameId":"game-1","kind":"REFUND","money":{"amount":"10.00","currency":"BRL"}}'
```

Depois `curl -X POST http://localhost:3000/wallets/$WALLET_ID/reconciliation` deverá retornar `consistent: true`.

## Limitações que precisam ser conhecidas

- Ainda não foram executados testes de queda forçada após commit, 3 processos simultâneos de verdade, nem testes formais de múltiplos publishers; estão previstos na etapa final.
- A fila de eventos é publicada, mas não há consumidor externo de eventos no repositório. Qualquer consumidor de produção precisa de inbox próprio deduplicando `eventId`.
- A DLQ guarda mensagens inválidas sem lançar a operação rejeitada no ledger (pois contratos inválidos nunca entram no domínio).
- A ausência de autenticação é intencional e documentada em ARCHITECTURE.md; jamais exponha publicamente.
- A imutabilidade e unicidade do ledger são aplicadas pelo banco. A aplicação implementa um único movimento por transação. Conciliação continua sendo ferramenta de detecção, não autocorreção.
- Existe risco residual com uma mesma `Idempotency-Key` disputada entre wallets distintas: constraint global impede duplicação, mas a API pode retornar um `409 DUPLICATE_RESOURCE` genérico. Requer melhoria de normalização na próxima etapa.
