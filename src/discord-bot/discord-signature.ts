import { createPublicKey, verify } from 'node:crypto';

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Discord sends a fresh timestamp with every request; anything older is a replay. */
export const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const HEX_128 = /^[0-9a-fA-F]{128}$/;

/** Verifies a Discord interaction request exactly as documented
 * (https://docs.discord.com/developers/interactions/overview#setting-up-an-endpoint-validating-security-request-headers):
 * Ed25519 over `timestamp + rawBody` with the application's public key. Never throws — any
 * malformed input (bad hex, missing header, stale timestamp) is simply "not valid". */
export function verifyDiscordSignature(params: {
  publicKeyHex: string | null | undefined;
  signatureHex: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | string | undefined;
  /** Injectable clock (ms) for tests. */
  nowMs?: number;
}): boolean {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = params;
  if (!publicKeyHex || !signatureHex || !timestamp || rawBody === undefined) return false;
  if (!HEX_64.test(publicKeyHex) || !HEX_128.test(signatureHex)) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = (params.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_SIGNATURE_AGE_SECONDS) return false;

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8')]);
    return verify(null, message, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
