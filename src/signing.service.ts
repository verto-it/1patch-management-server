import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class SigningService implements OnModuleInit {
  private readonly logger = new Logger(SigningService.name);
  private secret!: string;

  onModuleInit() {
    const secret = process.env.SIGNING_SECRET;
    // FIX #3: refuse to start with a missing or weak secret
    if (!secret || secret.length < 32) {
      this.logger.error(
        'SIGNING_SECRET env var is missing or less than 32 characters. ' +
        'Set a strong random secret before starting the management server.',
      );
      process.exit(1);
    }
    this.secret = secret;
    this.logger.log('SigningService initialised — SIGNING_SECRET is configured');
  }

  signPayload(payload: unknown) {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', this.secret).update(body).digest('hex');
    this.logger.debug('Signed payload (algorithm=HMAC-SHA256)');
    return { payload, signature, algorithm: 'HMAC-SHA256' };
  }

  verifySignature(payload: unknown, signature: string): boolean {
    const body = JSON.stringify(payload);
    const expected = createHmac('sha256', this.secret).update(body).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()));
    } catch {
      return false;
    }
  }
}
