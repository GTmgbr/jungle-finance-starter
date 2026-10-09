# Arquitetura — decisões e escopo

## 1. Visão geral

O Jungle Finance é um monólito modular distribuído, desenvolvido com NestJS, TypeScript strict, Bun 1.x, TypeORM, PostgreSQL 16 e AWS SQS (emulado pelo LocalStack).

A aplicação pode executar múltiplas instâncias simultaneamente, compartilhando o PostgreSQL como fonte para saldos, ledger, idempotência e processamento financeiro.

A arquitetura prioriza correção financeira, concorrência, rastreabilidade e recuperação de falhas.

## 2. Integridade financeira

Valores monetários são representados pela classe imutável `Money`, utilizando `decimal.js`, sem `number` para cálculos financeiros. Valores são transmitidos como strings, por exemplo `"100.00"`, com precisão de duas casas decimais.

No PostgreSQL, os valores usam `NUMERIC(20,2)`. As principais garantias são:

- Saldo nunca negativo, protegido por `CHECK` no banco.
- Ledger imutável, com triggers que bloqueiam alterações e exclusões.
- Um lançamento de ledger por transação financeira, com validação dos saldos anterior e posterior.
- Restrições de unicidade para wallets, transações externas e chaves de idempotência.
- Atualização de wallet, transação, ledger e outbox na mesma transação SQL.

A reconciliação compara o saldo armazenado com a soma histórica dos créditos e débitos, utilizando isolamento `REPEATABLE READ`. Divergências são identificadas, mas nunca corrigidas automaticamente.

## 3. Concorrência e idempotência

O sistema utiliza locks pessimistas por wallet (`SELECT ... FOR UPDATE`) dentro de transações PostgreSQL.

Isso permite que operações sobre a mesma wallet sejam serializadas, enquanto wallets diferentes podem ser processadas em paralelo.

Exemplo: duas apostas simultâneas de R$ 80 sobre um saldo de R$ 100 não podem ser aprovadas juntas. A primeira pode ser processada; a segunda encontra saldo insuficiente e é rejeitada.

A idempotência é persistente e utiliza chaves únicas e hash SHA-256 do conteúdo de negócio normalizado. Repetições da mesma operação retornam o resultado original, sem duplicar débitos ou créditos.

## 4. Operações e estados

O domínio suporta `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, além de `OPENING` para saldo inicial.

As transações passam pelos estados `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED` ou `FAILED`.

Reversões validam a transação original, o provedor, a wallet, a moeda e demais dados relacionados. Operações recebidas fora de ordem podem aguardar em `PENDING_REFERENCE` para reprocessamento posterior.

Estados terminais não permitem novas transições.

## 5. Mensageria e recuperação

A integração com SQS utiliza os padrões Transactional Inbox e Transactional Outbox.

**Inbox:** registra mensagens consumidas na mesma transação do processamento financeiro. A confirmação no SQS ocorre somente após o commit, evitando efeitos financeiros duplicados em reentregas.

**Outbox:** registra eventos junto à operação financeira. Workers concorrentes utilizam `FOR UPDATE SKIP LOCKED` e leases para publicar eventos após o commit, com recuperação de publicações pendentes.

Falhas transitórias provocam novas tentativas; mensagens inválidas podem ser encaminhadas à DLQ. Referências ausentes são reprocessadas com backoff e limite de tentativas.

A entrega de eventos seguem o padrão at-least-once. Portanto, consumidores devem deduplicar eventos pelo `eventId`. SQS FIFO, isoladamente, não garante processamento exatamente uma vez de ponta a ponta.

## 6. Observabilidade

O endpoint `GET /metrics` disponibiliza métricas no formato Prometheus, incluindo:

- Transações por estado e eventos pendentes/publicados na outbox.
- Idade do evento pendente mais antigo e profundidade estimada da DLQ.
- Replays idempotentes, retentativas, conflitos de lock e divergências de reconciliação.
- Histograma de duração do processamento.

Métricas financeiras persistentes vêm do PostgreSQL. Contadores operacionais são locais a cada instância e reiniciam com o processo.

Também existem endpoints separados de liveness (`/health/live`) e readiness (`/health/ready`).

## 7. Segurança

A autenticação foi omitida conforme permitido pelo desafio.

O `NoopAuthGuard` representa um ponto de extensão para futura autenticação com Keycloak/OIDC, validação da identidade dos provedores e autorização de acesso às wallets.

## 8. Testes e validação

Em 10/10/2026, foram executados **24 testes com sucesso e nenhuma falha**, distribuídos em:

| Categoria | Testes aprovados |
|---|---:|
| Unidade e observabilidade | 7 |
| Integração financeira e SQS | 7 |
| Concorrência com três instâncias | 5 |
| Recuperação após falhas | 5 |
| **Total** | **24** |

Os cenários incluem disputas pelo mesmo saldo, 50 reentregas distribuídas, idempotência, reversões, recuperação da outbox, reinício de instâncias e mensagens encaminhadas à DLQ.

Os comandos e as evidências estão disponíveis no [README.md](README.md).

## 9. Limitações 

- Autenticação, TLS e rate limiting não foram implementados.
- Eventos da outbox podem ser publicados novamente após falhas entre envio e confirmação.
- O uso simultâneo da mesma chave idempotente em wallets distintas pode gerar conflito de unicidade genérico.
- Contadores operacionais não são persistidos nem agregados por um servidor Prometheus.
- Não foram testados todos os pontos possíveis de falha entre commit e ACK, nem indisponibilidades prolongadas do banco ou SQS.
- A reversão de migrations pode ser destrutiva e deve ocorrer somente em ambiente apropriado.
