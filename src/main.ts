import { readFileSync } from 'fs';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // ── TLS ─────────────────────────────────────────────────────────────────
  // Paths are written by vault/init-pki.ps1 and set in .env.
  // When TLS_CERT_PATH / TLS_KEY_PATH are present we boot HTTPS and require
  // every backend node to present a client certificate signed by our internal CA.
  const tlsCert = process.env.TLS_CERT_PATH;
  const tlsKey  = process.env.TLS_KEY_PATH;
  const tlsCa   = process.env.TLS_CA_PATH;

  const httpsOptions =
    tlsCert && tlsKey && tlsCa
      ? {
          cert:               readFileSync(tlsCert),
          key:                readFileSync(tlsKey),
          ca:                 readFileSync(tlsCa),
          requestCert:        true,   // ask every client for a certificate
          rejectUnauthorized: false,  // we enforce this ourselves per-route so
                                      // browser/API clients without certs still reach JWT-guarded endpoints
        }
      : undefined;

  if (!httpsOptions) {
    console.warn(
      '[WARN] TLS_CERT_PATH / TLS_KEY_PATH / TLS_CA_PATH are not set — ' +
      'server is running over plain HTTP. Run vault/init-pki.ps1 to enable mTLS.',
    );
  }

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    { bodyParser: false, httpsOptions },
  );
  app.use(helmet());

  const requestBodyLimit = process.env.REQUEST_BODY_LIMIT ?? '10mb';
  app.useBodyParser('json', { limit: requestBodyLimit });
  app.useBodyParser('urlencoded', { limit: requestBodyLimit, extended: true });

  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    console.warn('[WARN] CORS_ALLOWED_ORIGINS is not set — CORS is disabled. Set a comma-separated list of allowed origins.');
    app.enableCors({ origin: false });
  } else {
    app.enableCors({ origin: allowedOrigins, credentials: true });
    console.log(`[INFO] CORS enabled for: ${allowedOrigins.join(', ')}`);
  }

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('1Patch Management Server')
      .setDescription('Control-plane API for 1Patch management server')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('/docs', app, SwaggerModule.createDocument(app, config));
    console.log('[INFO] Swagger docs available at /docs (non-production mode)');
  } else {
    console.log('[INFO] Swagger docs disabled in production');
  }

  const port = Number(process.env.PORT ?? 4100);
  await app.listen(port);
  const proto = httpsOptions ? 'https' : 'http';
  console.log(`[INFO] 1Patch management server listening on ${proto}://0.0.0.0:${port}`);
  if (httpsOptions) {
    console.log('[INFO] mTLS enabled — backend nodes must present a Vault-issued client certificate');
  }
}

void bootstrap();
