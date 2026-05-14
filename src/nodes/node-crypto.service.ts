import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createPublicKey, verify } from 'crypto';
import { v4 as uuid } from 'uuid';
import { canonicalJson, computePayloadHash } from '../signing.service';
import { MemoryStore } from '../storage/memory.store';
import { NodeSignedEnvelope } from '../types';

const NODE_ENVELOPE_CLOCK_SKEW_MS = Number(process.env.NODE_ENVELOPE_CLOCK_SKEW_MS ?? 5 * 60_000);

@Injectable()
export class NodeCryptoService {
  constructor(private readonly store: MemoryStore) {}

  issueNonce(nodeId: string, purpose: NodeSignedEnvelope['payloadType']) {
    const nonce = uuid();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const challenge = { id: nonce, nodeId, purpose, createdAt: now.toISOString(), expiresAt, consumedAt: undefined };
    this.store.nodeChallengeNonces = [challenge, ...this.store.nodeChallengeNonces].slice(0, 5000);
    void this.store.persist();
    return { nonce, expiresAt, serverTime: now.toISOString() };
  }

  verifyEnvelope<T>(
    envelope: NodeSignedEnvelope<T>,
    expectedNodeId: string,
    expectedPayloadType: NodeSignedEnvelope['payloadType'],
  ): T {
    if (envelope.algorithm !== 'ES256') throw new BadRequestException('Unsupported node signature algorithm');
    if (envelope.nodeId !== expectedNodeId) throw new UnauthorizedException('Signed node envelope identity mismatch');
    if (envelope.payloadType !== expectedPayloadType) {
      throw new BadRequestException(`Expected ${expectedPayloadType} payload, got ${envelope.payloadType}`);
    }

    const issuedAt = Date.parse(envelope.issuedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
      throw new BadRequestException('Invalid signed node envelope timestamps');
    }
    if (Math.abs(Date.now() - issuedAt) > NODE_ENVELOPE_CLOCK_SKEW_MS) {
      throw new UnauthorizedException('Signed node envelope timestamp is outside the allowed clock-skew window');
    }
    if (expiresAt <= Date.now()) throw new UnauthorizedException('Signed node envelope has expired');

    const node = this.store.backendNodes.find((candidate) => candidate.id === expectedNodeId);
    if (!node?.signingPublicKeyPem) throw new UnauthorizedException('Node has no registered signing public key');

    const computedHash = computePayloadHash(envelope.payload);
    if (!envelope.payloadHash || computedHash !== envelope.payloadHash) {
      throw new UnauthorizedException('Signed node payload hash mismatch');
    }

    this.consumeNonce(envelope.nodeId, envelope.payloadType, envelope.nonce);

    const { signature, ...unsigned } = envelope;
    const ok = verify(
      'sha256',
      Buffer.from(canonicalJson(unsigned)),
      { key: createPublicKey(node.signingPublicKeyPem), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    if (!ok) throw new UnauthorizedException('Invalid node payload signature');
    return envelope.payload;
  }

  private consumeNonce(nodeId: string, purpose: string, nonce: string) {
    const challenge = this.store.nodeChallengeNonces.find((item) => item.id === nonce && item.nodeId === nodeId && item.purpose === purpose);
    if (!challenge) throw new UnauthorizedException('Unknown node nonce');
    if (challenge.consumedAt) throw new UnauthorizedException('Node nonce has already been used');
    if (Date.parse(challenge.expiresAt) <= Date.now()) throw new UnauthorizedException('Node nonce has expired');
    challenge.consumedAt = new Date().toISOString();
    void this.store.persist();
  }
}
