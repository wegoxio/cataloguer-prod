import { describe, it, expect } from 'vitest';
import { LOCK_RETRY_EXHAUSTED, isLockRetryExhaustion } from './family.service';

/**
 * The 409s an attachment can meet, as `apiRequest` hands them over: an Error
 * with the server's `message`, plus `status` and the raw `body`. Only the
 * lock-retry exhaustion is worth asking again; it is the one 409 the backend
 * sends with no code, and it always begins with the same sentence.
 */
const failure = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.message)), { status, body });

describe('isLockRetryExhaustion', () => {
  it('recognises the lock-retry exhaustion: 409, the sentence, no code', () => {
    const err = failure(409, {
      statusCode: 409,
      message: 'Store membership kept changing while this was being applied. Please try again.',
      error: 'Conflict',
    });
    expect(err.message.startsWith(LOCK_RETRY_EXHAUSTED)).toBe(true);
    expect(isLockRetryExhaustion(err)).toBe(true);
  });

  it('does not take a lifecycle refusal for it, although it is a 409', () => {
    for (const code of [
      'LIFECYCLE_RECORD_REMOVED',
      'LIFECYCLE_ORGANIZATION_MERGED',
      'LIFECYCLE_ORGANIZATION_ARCHIVED',
      'LIFECYCLE_ORGANIZATION_REMOVED',
    ]) {
      const err = failure(409, {
        message: 'That record has been removed, so this operation cannot reference it. Ask the platform owner to restore it first.',
        code,
      });
      expect(isLockRetryExhaustion(err), code).toBe(false);
    }
  });

  it('does not take the specification conflict for it either', () => {
    const err = failure(409, {
      code: 'FIELD_APPLICABILITY_CONFLICT',
      message: 'This family change would make existing specification values illegal. Move or remove the offending values first.',
    });
    expect(isLockRetryExhaustion(err)).toBe(false);
  });

  it('needs the absence of a code: the sentence on a 409 that carries one is a refusal, not a retry', () => {
    const err = failure(409, {
      message: `${LOCK_RETRY_EXHAUSTED}. Please try again.`,
      code: 'LIFECYCLE_RECORD_REMOVED',
    });
    expect(err.message.startsWith(LOCK_RETRY_EXHAUSTED)).toBe(true);
    expect(isLockRetryExhaustion(err)).toBe(false);
  });

  it('needs the sentence, not just a code-less 409', () => {
    expect(isLockRetryExhaustion(failure(409, { statusCode: 409, message: 'Something else conflicted', error: 'Conflict' }))).toBe(false);
  });

  it('needs the status: the sentence on a 400, or no status at all, is not it', () => {
    expect(isLockRetryExhaustion(failure(400, { message: `${LOCK_RETRY_EXHAUSTED}. Please try again.` }))).toBe(false);
    expect(isLockRetryExhaustion(new Error(`${LOCK_RETRY_EXHAUSTED}. Please try again.`))).toBe(false);
    expect(isLockRetryExhaustion(null)).toBe(false);
    expect(isLockRetryExhaustion(undefined)).toBe(false);
  });
});
