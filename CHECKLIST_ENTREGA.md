# Checklist da entrega — Jungle Finance

- [x] Compilação TypeScript strict (`bun run typecheck`) sem erros no Linux Mint do candidato.
- [x] 7 testes unitários, 7 de integração, 5 multi-instância e 5 de recuperação aprovados (8/out/2026).
- [x] Saúde (`/health/live`, `/health/ready`) e métricas (`/metrics`) observadas em funcionamento.
- [x] Outbox confirmada com zero pendentes e 128 publicados em uma consulta após recuperação.
- [ ] Revisar `git status`, evitar segredos, incluir `bun.lock` e fazer commit.
- [ ] Publicar repositório e executar setup em checkout limpo, se possível.
- [ ] Preparar explicação sobre locks por wallet, ledger, idempotência, inbox/outbox, falhas e trade-offs.

## Limitações conhecidas

- Autenticação é no-op por escolha deliberada e está documentada como extensão via IdP/OIDC.
- Contadores de métricas são locais a cada réplica e reiniciam com o processo.
- A outbox entrega ao menos uma vez; consumidores precisam deduplicar por `eventId`.
- Race de mesma chave de idempotência entre wallets diferentes pode retornar conflito SQL (409) em vez de replay amigável.
- Não há teste determinístico que mate o worker exatamente após commit e antes de ACK, nem teste prolongado de falha de PostgreSQL e SQS.
- Não declarar o serviço pronto para produção: credenciais e endpoints locais são de demonstração.
