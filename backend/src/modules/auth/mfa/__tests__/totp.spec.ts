import { base32Encode, totpAt, verifyTotp, encryptSecret, decryptSecret, generateSecret } from '../totp';

describe('TOTP', () => {
  // RFC 6238 test vectors (SHA1, truncated to 6 digits)
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  it('matches the RFC 6238 vectors', () => {
    expect(totpAt(rfcSecret, 59_000)).toBe('287082');
    expect(totpAt(rfcSecret, 1111111109_000)).toBe('081804');
    expect(totpAt(rfcSecret, 1234567890_000)).toBe('005924');
  });

  it('accepts codes within the drift window and rejects others', () => {
    const now = 1111111109_000;
    expect(verifyTotp(rfcSecret, '081804', now)).toBe(true);
    expect(verifyTotp(rfcSecret, '287082', now)).toBe(false);
    expect(verifyTotp(rfcSecret, 'abcdef', now)).toBe(false);
  });

  it('round-trips secret encryption', () => {
    const secret = generateSecret();
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    expect(secret).toHaveLength(32);
  });
});
