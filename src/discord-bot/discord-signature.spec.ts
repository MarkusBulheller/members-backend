import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyDiscordSignature } from './discord-signature.js';

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKeyHex: der.subarray(der.length - 32).toString('hex') };
}

const NOW_MS = Date.UTC(2026, 9, 22, 12, 0, 0);
const NOW_S = String(NOW_MS / 1000);
const BODY = Buffer.from(JSON.stringify({ type: 1 }));

function signed(privateKey: ReturnType<typeof makeKeyPair>['privateKey'], timestamp = NOW_S, body = BODY) {
  return sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex');
}

describe('verifyDiscordSignature', () => {
  const { privateKey, publicKeyHex } = makeKeyPair();

  it('accepts a correctly signed request', () => {
    expect(
      verifyDiscordSignature({ publicKeyHex, signatureHex: signed(privateKey), timestamp: NOW_S, rawBody: BODY, nowMs: NOW_MS }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex: signed(privateKey),
        timestamp: NOW_S,
        rawBody: Buffer.from(JSON.stringify({ type: 2 })),
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex: signed(privateKey),
        timestamp: String(Number(NOW_S) + 1),
        rawBody: BODY,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects a signature made with a different key', () => {
    const other = makeKeyPair();
    expect(
      verifyDiscordSignature({ publicKeyHex: other.publicKeyHex, signatureHex: signed(privateKey), timestamp: NOW_S, rawBody: BODY, nowMs: NOW_MS }),
    ).toBe(false);
  });

  it('rejects a stale (older than 5 minutes) timestamp even when correctly signed', () => {
    const stale = String(Number(NOW_S) - 301);
    expect(
      verifyDiscordSignature({ publicKeyHex, signatureHex: signed(privateKey, stale), timestamp: stale, rawBody: BODY, nowMs: NOW_MS }),
    ).toBe(false);
    const fresh = String(Number(NOW_S) - 299);
    expect(
      verifyDiscordSignature({ publicKeyHex, signatureHex: signed(privateKey, fresh), timestamp: fresh, rawBody: BODY, nowMs: NOW_MS }),
    ).toBe(true);
  });

  it('rejects missing headers, no configured key, and malformed hex without throwing', () => {
    const base = { publicKeyHex, signatureHex: signed(privateKey), timestamp: NOW_S, rawBody: BODY, nowMs: NOW_MS };
    expect(verifyDiscordSignature({ ...base, publicKeyHex: null })).toBe(false);
    expect(verifyDiscordSignature({ ...base, signatureHex: undefined })).toBe(false);
    expect(verifyDiscordSignature({ ...base, timestamp: undefined })).toBe(false);
    expect(verifyDiscordSignature({ ...base, rawBody: undefined })).toBe(false);
    expect(verifyDiscordSignature({ ...base, signatureHex: 'zz'.repeat(64) })).toBe(false);
    expect(verifyDiscordSignature({ ...base, publicKeyHex: 'abcd' })).toBe(false);
    expect(verifyDiscordSignature({ ...base, timestamp: 'not-a-number' })).toBe(false);
  });
});
