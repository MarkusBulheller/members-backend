import { generateKeyPairSync, sign } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DiscordInteractionsController } from './discord-interactions.controller.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const der = publicKey.export({ format: 'der', type: 'spki' });
const PUBLIC_KEY_HEX = der.subarray(der.length - 32).toString('hex');

function makeController(storedKey: string | null = PUBLIC_KEY_HEX) {
  const settings = { getInteractionConfig: vi.fn().mockResolvedValue({ publicKey: storedKey, alertUserId: null }) };
  const interactions = { handle: vi.fn().mockResolvedValue({ type: 4, data: { content: 'x' } }) };
  return { controller: new DiscordInteractionsController(settings as never, interactions as never), interactions };
}

function signedRequest(body: object) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('hex');
  return { req: { rawBody } as never, signature, timestamp };
}

describe('DiscordInteractionsController', () => {
  it('hands a correctly signed interaction to the handler', async () => {
    const { controller, interactions } = makeController();
    const { req, signature, timestamp } = signedRequest({ type: 1 });
    expect(await controller.interactions(req, signature, timestamp)).toEqual({ type: 4, data: { content: 'x' } });
    expect(interactions.handle).toHaveBeenCalledWith({ type: 1 });
  });

  it('answers 401 for a bad signature, missing headers, or no configured key', async () => {
    const { controller, interactions } = makeController();
    const { req, signature, timestamp } = signedRequest({ type: 1 });
    await expect(controller.interactions(req, 'ab'.repeat(64), timestamp)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.interactions(req, undefined, timestamp)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.interactions(req, signature, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(makeController(null).controller.interactions(req, signature, timestamp)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(interactions.handle).not.toHaveBeenCalled();
  });
});
