import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/** Intencionalmente no-op neste desafio. Substituir por guard OIDC/Keycloak e validar providerId. */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean { return true; }
}
