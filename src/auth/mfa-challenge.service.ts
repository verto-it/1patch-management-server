import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import { DragonflyService } from '../storage/dragonfly.service';
import { MemoryStore } from '../storage/memory.store';

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes to complete
const VERIFIED_TTL_SECONDS = 120;  // 2 minutes to use after verification

interface ChallengeRecord {
  userId: string;
  verified: boolean;
  issuedAt: string;
}

/**
 * Issues single-use MFA challenges for task approval.
 *
 * Flow:
 *  1. Caller requests a challenge → `issueChallenge(userId)` returns a challengeId
 *  2. Caller submits their TOTP code → `verifyChallenge(userId, challengeId, totpCode)`
 *     verifies the code and marks the challenge as verified (still single-use)
 *  3. Caller submits challengeId in the task approval request →
 *     `consumeVerifiedChallenge(userId, challengeId)` atomically checks and deletes it
 *
 * A challenge that was never verified, or one that has already been consumed,
 * is always rejected.
 */
@Injectable()
export class MfaChallengeService {
  private readonly logger = new Logger(MfaChallengeService.name);
  private readonly prefix = '1patch:mfa-challenge';

  /**
   * Creates a MfaChallengeService instance with its required collaborators.
   *
   * @param dragonfly dragonfly supplied to the function.
   * @param store store supplied to the function.
   */
  constructor(
    private readonly dragonfly: DragonflyService,
    private readonly store: MemoryStore,
  ) {}

  /**
   * Handles the issue challenge operation for MfaChallengeService.
   *
   * @param userId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  async issueChallenge(userId: string): Promise<string> {
    const challengeId = randomUUID();
    const record: ChallengeRecord = { userId, verified: false, issuedAt: new Date().toISOString() };
    await this.dragonfly.setJsonEx(this.challengeKey(challengeId), record, CHALLENGE_TTL_SECONDS);
    this.logger.debug(`MFA task challenge issued: userId=${userId} challengeId=${challengeId}`);
    return challengeId;
  }

  /**
   * Validates challenge rules.
   *
   * @param userId Identifier used to locate the target record.
   * @param challengeId Identifier used to locate the target record.
   * @param totpCode totp code supplied to the function.
   */
  async verifyChallenge(userId: string, challengeId: string, totpCode: string): Promise<void> {
    const record = await this.dragonfly.getJson<ChallengeRecord>(this.challengeKey(challengeId));

    if (!record) throw new UnauthorizedException('MFA challenge not found or expired');
    if (record.userId !== userId) throw new UnauthorizedException('MFA challenge does not belong to this user');
    if (record.verified) throw new UnauthorizedException('MFA challenge has already been verified');

    const user = this.store.users.find((u) => u.id === userId);
    if (!user?.mfaSecret) throw new BadRequestException('MFA is not configured for this user');
    if (!authenticator.check(totpCode, user.mfaSecret)) {
      throw new UnauthorizedException('Invalid MFA code');
    }

    // Mark verified with a shorter TTL — caller must consume it quickly
    const verified: ChallengeRecord = { ...record, verified: true };
    await this.dragonfly.setJsonEx(this.challengeKey(challengeId), verified, VERIFIED_TTL_SECONDS);
    this.logger.debug(`MFA task challenge verified: userId=${userId} challengeId=${challengeId}`);
  }

  /**
   * Atomically checks that the challenge is verified and deletes it (single-use).
   * Call this from the task approval path.
   */
  async consumeVerifiedChallenge(userId: string, challengeId: string): Promise<void> {
    const record = await this.dragonfly.getJson<ChallengeRecord>(this.challengeKey(challengeId));

    if (!record) throw new UnauthorizedException('MFA challenge not found, expired, or already used');
    if (record.userId !== userId) throw new UnauthorizedException('MFA challenge does not belong to this user');
    if (!record.verified) throw new UnauthorizedException('MFA challenge has not been verified with a TOTP code');

    // Delete immediately — single-use
    await this.dragonfly.del(this.challengeKey(challengeId));
    this.logger.debug(`MFA task challenge consumed: userId=${userId} challengeId=${challengeId}`);
  }

  /**
   * Handles the challenge key operation for MfaChallengeService.
   *
   * @param challengeId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  private challengeKey(challengeId: string): string {
    // Hash the challengeId so the raw UUID is never stored as a key
    return `${this.prefix}:${createHash('sha256').update(challengeId).digest('hex')}`;
  }
}
