# ARCHITECTURE — decisões, invariantes e escopo

## Objetivo

Aplicação **monolítica modular**, implantável com múltiplas instâncias idênticas. O PostgreSQL é a fonte única de verdade para saldo materializado, ledger e idempotência. O SQS tem semântica *at-least-once*, nunca é usado como mecanismo primário de correção.

## Stack

- **Bun 1.x:** runtime, package manager e runner de testes. Compilação TypeScript via `tsc`, execução com Bun para garantir emissão de `emitDecoratorMetadata` das classes NestJS.
- **NestJS 11 + TypeScript strict:** controllers finos, services coordenam use cases.
- **TypeORM 0.3:** aceito pelo enunciado. Mapeamos entidades de persistência separadas do domínio para não poluir `Money`, `Wallet` e `WagerTransaction` com decorators ORM. `DataSource.transaction` e `pessimistic_write` permitem locks por wallet com código pequeno.
- **PostgreSQL 16:** `NUMERIC(20,2)` para dinheiro; transações e invariantes por constraints/triggers.
- **LocalStack SQS:** filas FIFO inicializadas por hook no Compose. A FIFO é otimização, **não** substitui constraints, inbox e locks.

## Money

Money é imutável e usa `decimal.js`, **nunca number** para valores financeiros. `amount` entra/saí como string `"25.00"`, escala exatamente 2. Entrada negativa é inválida. Operações internas podem produzir número negativo (ex.: `subtract`, diferença de reconciliação), representado ainda como string. `currency` continua no tipo de domínio e nas colunas; operações com moedas distintas falham. Maior magnitude permitida pelo domínio: 18 dígitos inteiros + 2 decimais para combinar com `NUMERIC(20,2)`.

## Banco e invariantes

1. `UNIQUE(player_id,currency)` em wallets; `CHECK (balance >= 0)`.
2. `UNIQUE(idempotency_key)` e `UNIQUE(provider_id,external_transaction_id)`; hash SHA-256 dos campos de negócio normalizados, JSON recursivamente ordenado, **sem header e sem metadados de transporte**.
3. Uma entrada do ledger por transação: `UNIQUE(transaction_id)`; ledger imutável por triggers de `UPDATE`, `DELETE` e `TRUNCATE`.
4. `CHECK` de ledger testa `balance_before +/- amount = balance_after`, valores positivos e saldos não negativos.
5. Wager status enumerado por CHECK, referências de reversão e `failure_code` obrigatório para rejeições/falhas. Índice único parcial proíbe duas reversões do mesmo tipo quando a referência está resolvida.
6. A aplicação grava wallet, transaction, ledger e eventos outbox **dentro da mesma transação SQL**; inbox do consumidor participa do mesmo commit para entrada SQS.
7. `wallet.version` começa em 1 (inclusive quando OPENING gera o saldo inicial). Incrementa somente em mudanças **subsequentes** do saldo. `LOSS` e `REJECTED` não incrementam nem criam ledger.
8. Para wallets inicialmente zeradas, não há OPENING/ledger.

**Reconciliação:** valor reconstruído é soma dos créditos menos débitos de **toda a história** da wallet. Um `REPEATABLE READ` fornece snapshot consistente enquanto outras transações são processadas. Divergência não é corrigida automaticamente.

## Concorrência

A unidade de serialização é `walletId`. Cada `submit` abre transação SQL e executa `SELECT ... FROM wallets WHERE id = ? FOR UPDATE` antes de ler/verificar idempotência e mover dinheiro. Duas apostas de 80.00 com saldo 100.00 ficam serializadas: a primeira pode debitar, a seguinte observa 20.00 e é REJECTED; não há lost update. Wallets distintas processam em paralelo. O lock é mantido somente durante um commit financeiro, sem lock global.

**Limitação ainda presente:** chave idempotente compartilhada entre *wallets diferentes* depende do `UNIQUE` do PostgreSQL e pode retornar `409 DUPLICATE_RESOURCE` em caso de corrida; o tratamento pode ser refinado sem comprometer unicidade. Para a mesma wallet, retries são serializados e retornam o resultado original armazenado.

## Estados

- `PENDING -> PROCESSED` ou `REJECTED`, ou `PENDING -> PENDING_REFERENCE -> PROCESSED/REJECTED`, com novas tentativas enquanto não há referência.
- `PROCESSED`, `REJECTED`, `FAILED` são terminais, guardados por métodos do domínio.
- `LOSS` é `PROCESSED`, sem ledger nem mudança de versão.
- `OPENING` é interno, nunca aceito por HTTP ou fila; factory `rehydrate` remonta estados persistidos sem revalidar transições.
- Reversões são processadas sob o lock da wallet. Para REFUND/ROLLBACK, a referência processada válida precisa corresponder ao provider, wallet, player, moeda, rodada e valor. WIN pode opcionalmente ter referência BET da mesma rodada e valor diferente.

## Inbox / Outbox e mensagens — etapa 2

**Inbox:** consumidor SQS registra `(consumerName,messageId,payloadHash)` dentro da mesma transação do use case financeiro; somente confirma a mensagem (`DeleteMessage`) depois do commit. Erros permanentes de payload ou domínio são encaminhados à DLQ antes do ACK; erros transitórios permanecem na fila até redelivery, com `maxReceiveCount=5` no redrive da SQS. Em SIGTERM, o worker aguarda a chamada em andamento; se o ACK falhar, a mensagem pode reaparecer sem duplicar débito.

**Outbox:** publishers concorrentes reservam mensagens com `FOR UPDATE SKIP LOCKED` e lease no banco. Publicam depois do commit e só então marcam `published_at`. Falha entre publicação e atualização pode resultar em duplicata; para isso o `eventId` persistido entra no envelope e é usado como `MessageDeduplicationId` no FIFO. Deduplicação durável continua sendo responsabilidade de cada consumidor downstream.

**Fora de ordem:** referências não encontradas geram `PENDING_REFERENCE`; `attempts/next_attempt_at` governam o reprocessamento com até 8 tentativas e backoff 1s→60s. Esgotamento gera `REJECTED/REFERENCE_NOT_FOUND` com evento. Escolhemos teto curto para testes reproduzíveis; em produção a janela seria configurável conforme latência dos provedores. REFUND só reverte BET; ROLLBACK inverte BET/WIN/REFUND. Débito de reversão sem fundos usa `REVERSAL_INSUFFICIENT_FUNDS`, distinto de BET.

## Autenticação (deliberadamente não implementada)

Conforme enunciado, autenticação **não pontua**. Existe `src/common/auth.guard.ts` com `NoopAuthGuard` registrado em `APP_GUARD` como extensão explícita. Em produção usaríamos Keycloak/OIDC para validar tokens e permissões, mapeando a identidade autenticada ao `providerId` do payload, e controlando acesso a wallets. Os endpoints `/health/*` são públicos; mensagens de fila seriam do canal interno confiável, mas `providerId` seria validado contra o registro de identidade do provedor. **Não colocar esta API desprotegida em rede pública.**

## Observabilidade (etapa 5)

- `GET /metrics` expõe métricas em formato texto Prometheus, implementadas com TypeScript e SQL, sem biblioteca adicional. Os gauges `jungle_wager_transactions{status}`, `jungle_outbox_pending`, `jungle_outbox_published`, `jungle_outbox_retried_events` e `jungle_outbox_oldest_pending_seconds` vêm do PostgreSQL; a profundidade aproximada da DLQ é consultada no SQS.
- `jungle_idempotent_replays_total`, retries de SQS/outbox/referências, envios explícitos a DLQ, conflitos de lock, reconciliações divergentes e histograma de latência são contadores **por processo**. Reiniciam com cada réplica, não são garantias financeiras e não substituem a auditoria persistente. Requerem coleta das três réplicas; não somar gauges SQL compartilhados.
- Se a consulta à DLQ falhar, `jungle_dlq_metrics_available=0` e a métrica de profundidade é omitida; não se apresenta zero falsamente. Health live e ready permanecem separados.
- Logs JSON indicam evento, `transactionId`, `walletId`, `providerId`, `correlationId`, `messageId` quando disponíveis. Ainda há lacunas de contexto em logs de alguns workers; nenhum payload financeiro completo é impresso.
- O endpoint `/metrics` está aberto para desenvolvimento local, **não expor sem controle** em produção.

## Testes executados no Linux Mint do candidato (8/out/2026)

- 7 testes de unidade (Money, wallet, ledger, estados e observabilidade) passaram.
- 7 testes de integração/concurrency passaram, cobrindo 50 repetições, saldo disputado, idempotência, reversões, referências fora de ordem, SQS/inbox.
- 5 testes multi-instância passaram sobre 3 processos e PostgreSQL compartilhado.
- 5 testes de recuperação passaram, incluindo lease de outbox expirado, reinícios, DLQ e constraints, após correção do publisher e remoção da premissa incorreta de que `attempts` sempre é zero ao concluir.
- Consulta operacional mostrou 128 eventos marcados como publicados, 0 pendentes e 109 eventos com `attempts > 0`; isso confirma a drenagem naquele instante, não uma garantia universal contra novas falhas.
- A instrumentação da etapa 5 passou em `bun run typecheck` e `bun run test`; o endpoint `/metrics` respondeu com dados SQL da outbox e transações.
- As quatro suítes, executadas separadamente, totalizaram 24 testes aprovados e 0 falhas. Isso não demonstra exaustivamente todos os interleavings possíveis nem a recuperação em toda falha real.

## Trade-offs conhecidos / riscos atuais

- Não é produção: `NoopAuthGuard` intencional, sem TLS, limitação de taxa ou identidade de provedores autenticada.
- Após confirmação do SQS e antes de gravar `published_at`, queda pode gerar evento duplicado. O destino deduplica por `eventId`; FIFO deduplica temporariamente, não para sempre.
- Chave de idempotência em corrida entre wallets diferentes depende do UNIQUE do PostgreSQL; pode haver `409 DUPLICATE_RESOURCE` e não replay legível. Evitamos escopo extra para não comprometer correção financeira.
- Metrics por processo são efêmeras; ausência de Prometheus ou agregador persiste como trade-off do timebox.
- Ausência de injeção determinística de falhas no exato intervalo entre commit e ACK e de testes de indisponibilidade prolongada de SQS/PostgreSQL.
- Migrações `up/down` são versionadas, mas `down` é destrutivo; não executar sobre dados que devam ser preservados.
- Após instalar dependências, commitar `bun.lock` (gerado localmente), que não integra os ZIPs de atualização.
