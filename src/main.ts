import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { shouldCompress } from './common/compression-filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // gzip JSON etc.; shouldCompress() keeps the live team-plan SSE stream (and any event-stream) uncompressed.
  app.use(compression({ filter: shouldCompress }));
  app.use(cookieParser());
  // CORS_ORIGIN is the members-portal (needs credentials for the session cookie).
  // PUBLIC_SITE_ORIGIN is the separate, anonymous marketing site — only ever calls the
  // unguarded /stats/public-summary endpoint, no cookies involved, but still needs its
  // own explicit allowlist entry rather than a wildcard (credentials:true forbids one anyway).
  const allowedOrigins = [configService.getOrThrow<string>('CORS_ORIGIN'), configService.get<string>('PUBLIC_SITE_ORIGIN')].filter(
    (origin): origin is string => Boolean(origin),
  );
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = configService.get<string>('PORT', '3001');
  await app.listen(port);
}
await bootstrap();
