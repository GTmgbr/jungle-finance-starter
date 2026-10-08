# Hotfix — Publicação da outbox

Este pacote substitui apenas `src/workers/workers.service.ts`.

## Causa

No PostgreSQL, `EntityManager.query()` do TypeORM devolve `[rows, rowCount]` para `UPDATE ... RETURNING`. O worker iterava sobre essa tupla como se fosse a lista de eventos e enviava `MessageBody` inválido. O LocalStack respondia HTTP 500, os eventos ficavam pendentes e `attempts` não era incrementado.

## Correção

Executar `SELECT ... FOR UPDATE SKIP LOCKED` e, dentro da mesma transação, executar `UPDATE` para reservar os IDs selecionados. O worker só publica depois do commit, preservando at-least-once e a recuperação quando a reserva expira.

## Passos (dentro da pasta jungle-finance-starter)

1. Descompactar na raiz do projeto com `unzip -o ... -d .`.
2. `bun run typecheck`
3. `docker compose --profile concurrency up -d --build`
4. Verificar que os eventos pendentes diminuem (SQL abaixo).
5. `bun run test:recovery`

```bash
docker compose exec -T postgres psql -U jungle -d jungle_finance -c \
  "SELECT count(*) FILTER (WHERE published_at IS NULL) AS pending, count(*) FILTER (WHERE published_at IS NOT NULL) AS published FROM outbox_messages;"
```

Não execute `docker compose down -v`: isso removeria o banco de dados de teste.
