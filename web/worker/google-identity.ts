import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const SCHOOL_DOMAIN = 'cpu.edu.hk';
const STUDENT_EMAIL = /^s[0-9]{7}@cpu\.edu\.hk$/i;
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export class GoogleIdentityError extends Error {
  readonly status: 403 | 503;

  constructor(status: 403 | 503) {
    super(
      status === 403
        ? 'Sign in with the invited school Google account.'
        : 'Google verification is temporarily unavailable. Please try again.',
    );
    this.status = status;
  }
}

const resolveGoogleKey: JWTVerifyGetKey = async (header, token) => {
  if (typeof header.kid !== 'string' || !header.kid) throw new GoogleIdentityError(403);
  try {
    return await googleKeys(header, token);
  } catch (err) {
    if (err instanceof errors.JWKSNoMatchingKey) throw err;
    throw new GoogleIdentityError(503);
  }
};

// The Worker uses Google's pinned key set. Tests supply their own signing keys.
export function createGoogleStudentVerifier(resolveKey: JWTVerifyGetKey) {
  return async function verifyGoogleStudent(
    credential: string,
    clientId: string,
    nonce: string,
    expectedEmail: string,
  ): Promise<void> {
    if (!clientId) throw new GoogleIdentityError(503);
    if (!credential || credential.length > 8192 || !nonce || !STUDENT_EMAIL.test(expectedEmail)) {
      throw new GoogleIdentityError(403);
    }

    try {
      const { payload } = await jwtVerify(credential, resolveKey, {
        algorithms: ['RS256'],
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
        requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email_verified', 'hd', 'email'],
      });
      if (
        payload.aud !== clientId ||
        (payload.azp !== undefined && payload.azp !== clientId) ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! > Math.floor(Date.now() / 1000) + 30 ||
        payload.exp! <= payload.iat! ||
        typeof payload.sub !== 'string' ||
        !payload.sub.trim() ||
        payload.nonce !== nonce ||
        payload.email_verified !== true ||
        payload.hd !== SCHOOL_DOMAIN ||
        typeof payload.email !== 'string' ||
        !STUDENT_EMAIL.test(payload.email) ||
        payload.email.toLowerCase() !== expectedEmail.toLowerCase()
      )
        throw new GoogleIdentityError(403);
    } catch (err) {
      if (err instanceof GoogleIdentityError) throw err;
      throw new GoogleIdentityError(403);
    }
  };
}

export const verifyGoogleStudent = createGoogleStudentVerifier(resolveGoogleKey);
