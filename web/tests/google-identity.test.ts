import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createGoogleStudentVerifier, GoogleIdentityError } from '../worker/google-identity.ts';

const algorithm = 'RS256';
const clientId = 'classroom-client.apps.googleusercontent.com';
const nonce = 'test-challenge-bound-to-invitation';
const email = 's1234567@cpu.edu.hk';

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair(algorithm);
  const jwk = await exportJWK(publicKey);
  const verify = createGoogleStudentVerifier(
    createLocalJWKSet({ keys: [{ ...jwk, kid: 'test' }] }),
  );
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = {
    iss: 'https://accounts.google.com',
    aud: clientId,
    azp: clientId,
    sub: '123456789',
    hd: 'cpu.edu.hk',
    email,
    email_verified: true,
    nonce,
    iat: now,
    exp: now + 300,
  };
  const sign = (payload: JWTPayload, key = privateKey) =>
    new SignJWT(payload).setProtectedHeader({ alg: algorithm, kid: 'test' }).sign(key);
  const check = (credential: string, invitedEmail = email) =>
    verify(credential, clientId, nonce, invitedEmail);
  return { sign, check, claims };
}

const forbidden = (err: unknown) => err instanceof GoogleIdentityError && err.status === 403;

test('a signed school Google ID token must prove the exact invited student and challenge', async () => {
  const { sign, check, claims } = await fixture();
  await check(await sign(claims));
  await check(
    await sign({
      ...claims,
      iss: 'accounts.google.com',
      email: email.toUpperCase(),
      azp: undefined,
    }),
  );

  for (const change of [
    { email: 's1234568@cpu.edu.hk' },
    { email: 'staff@cpu.edu.hk' },
    { email: 's1234567@gmail.com' },
    { email_verified: false },
    { email_verified: 'true' },
    { hd: undefined },
    { hd: 'other.edu.hk' },
    { sub: '' },
    { sub: undefined },
    { nonce: 'another-registration' },
    { nonce: undefined },
    { aud: 'different-client' },
    { aud: [clientId, 'unexpected-client'] },
    { azp: 'another-client' },
    { iss: 'https://not-google.example' },
    { exp: 1 },
    { exp: undefined },
    { iat: undefined },
    { iat: Math.floor(Date.now() / 1000) + 600 },
  ]) {
    await assert.rejects(
      check(await sign({ ...claims, ...change })),
      forbidden,
      JSON.stringify(change),
    );
  }
  const wrongFormat = 's12345@cpu.edu.hk';
  await assert.rejects(
    check(await sign({ ...claims, email: wrongFormat }), wrongFormat),
    forbidden,
  );
});

test('forged credentials fail regardless of matching school claims', async () => {
  const { sign, check, claims } = await fixture();
  const attacker = await generateKeyPair(algorithm);
  await assert.rejects(check(await sign(claims, attacker.privateKey)), forbidden);

  const hmac = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', kid: 'test' })
    .sign(new TextEncoder().encode('arbitrary attacker-controlled test key'));
  await assert.rejects(check(hmac), forbidden);
  await assert.rejects(check('untrusted-client-email'), forbidden);
});
