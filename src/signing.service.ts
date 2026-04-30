import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';

@Injectable()
export class SigningService {
  signPayload(payload: unknown) {
    const body = JSON.stringify(payload);
    const secret = process.env.SIGNING_SECRET ?? 'development-signing-secret';
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return { payload, signature, algorithm: 'HMAC-SHA256' };
  }
}
