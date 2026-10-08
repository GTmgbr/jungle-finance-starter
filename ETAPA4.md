# Etapa 4 — Recuperação e provas no banco

A suíte desta etapa testa **PostgreSQL e LocalStack reais** e executa reinicializações das três instâncias da API. Não faz mock do banco nem da fila. O pacote inclui `tests/recovery.test.ts` e o comando `bun run test:recovery`.

## Pré-requisito

```bash
docker compose --profile concurrency up -d --build
bun install
bun run typecheck
bun run test:recovery
```

**Importante:** não rode `test:recovery` simultaneamente com outros testes. Ele usa `docker compose stop/start/restart api api2 api3` e exige o Docker Compose na pasta do projeto. Ele **não apaga volumes nem altera migrations**. As wallets e eventos de teste ficam gravados, intencionalmente auditáveis.

## Cenários

1. O schema impede saldo negativo e alteração/exclusão de entradas do ledger.
2. Três publishers ativos conseguem resgatar um evento cujo lock na outbox foi abandonado; o teste insere um evento diagnóstico `RecoveryProbe` que não altera dinheiro.
3. Três containers são reiniciados; uma aposta já confirmada mantém saldo, versão, ledger e replay idempotente.
4. Mensagem SQS enviada quando todos os consumidores estão parados é processada após a retomada, e reenvio não debita novamente.
5. Envelope inválido vai para DLQ sem ser persistido na inbox financeira.

## O que esses testes NÃO demonstram

- **Kill exato entre COMMIT e ACK:** precisa de *fault injection* no ponto exato, ainda não implementado. O teste 4 comprova persistência da mensagem quando não há consumidores, não aquele ponto específico de falha.
- **Kill exato depois de `SendMessage` e antes de `published_at`:** ainda falta um teste dirigido de duplicação de evento. Outbox trabalha com semântica at-least-once; consumidores de eventos devem deduplicar pelo `eventId`.
- **Observabilidade:** os logs JSON já existem, mas métricas completas e latência ainda precisam ser avaliadas.
- **Carga/throughput:** não incluídos.

Essas lacunas devem constar honestamente na apresentação e no `ARCHITECTURE.md` final.

## Se falhar

```bash
docker compose ps -a
docker compose logs --tail=100 api api2 api3 localstack postgres
```

Para reerguer o ambiente sem apagar os dados:

```bash
docker compose --profile concurrency up -d
```

**Não execute `docker compose down -v`** (isso remove o volume do PostgreSQL).
