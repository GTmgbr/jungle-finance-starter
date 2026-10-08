import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: false });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(JSON.stringify({ event: 'server_started', port }));
}
bootstrap().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed',
    errorType: err instanceof Error ? err.name : 'unknown' }));
  process.exitCode = 1;
});
