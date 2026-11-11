import type { Database } from './storage.ts';
import { GoogleIdentityError, verifyGoogleStudent } from './google-identity.ts';

export type Role = 'admin' | 'student';
export interface User {
  username: string;
  role: Role;
  isPrimary: boolean;
}
interface StoredUser extends Omit<User, 'isPrimary'> {
  is_primary: number;
}
interface AccountRow extends StoredUser {
  reset_requested?: number;
  recovery_email: string | null;
  active: number;
  version: string;
}
interface Credentials extends AccountRow {
  salt: string;
  password_hash: string;
}

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const COOKIE = '__Host-course_session';
const HOUR = 3600000;
const SESSION_AGE = 12 * HOUR;
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function digest(value: string) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bytes = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    key,
    256,
  );
  return hex(bytes);
}

function equalHash(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function saltedPassword(password: string) {
  const salt = randomToken();
  return { salt, hash: await passwordHash(password, salt) };
}

function accountRole(value: unknown): Role {
  if (value !== 'student' && value !== 'admin')
    throw new HttpError(400, 'Choose a student or admin role.');
  return value;
}

export function rejectPrimaryField(input: Record<string, unknown>) {
  if ('isPrimary' in input || 'is_primary' in input)
    throw new HttpError(400, 'Primary status is assigned during classroom setup.');
}

function requireGrantAuthority(actor: User, role: Role) {
  if (role === 'admin' && !actor.isPrimary)
    throw new HttpError(403, 'Only the primary administrator can grant administrator access.');
}

function publicUser(row: StoredUser): User {
  return {
    username: row.username,
    role: row.role,
    isPrimary: Boolean(row.is_primary),
  };
}

function insertAccount(db: Database, user: User, credentials: { salt: string; hash: string }) {
  if (db.all('SELECT 1 FROM users WHERE username=?', user.username).length)
    throw new HttpError(409, 'Username already in use.');
  db.write(
    'INSERT INTO users (username,salt,password_hash,role,version,is_primary) VALUES (?,?,?,?,?,?)',
    user.username,
    credentials.salt,
    credentials.hash,
    user.role,
    randomToken(),
    Number(user.isPrimary),
  );
}

export async function createAccount(
  db: Database,
  input: Record<string, unknown>,
  requireAdmin: () => User,
): Promise<User> {
  const { username, password } = validateLogin(input);
  rejectPrimaryField(input);
  const user = { username, role: accountRole(input.role), isPrimary: false };
  requireGrantAuthority(requireAdmin(), user.role);
  const credentials = await saltedPassword(password);
  db.atomic(() => {
    requireGrantAuthority(requireAdmin(), user.role);
    insertAccount(db, user, credentials);
  });
  return user;
}

export class MailDeliveryError extends Error {
  readonly reason: 'url' | 'permission' | 'rejected' | 'provider';
  constructor(reason: MailDeliveryError['reason']) {
    super('Password recovery mail delivery failed.');
    this.reason = reason;
  }
}
const mailIssues = {
  url: 'Check the Apps Script web app URL in Cloudflare.',
  permission: 'Check Apps Script web app access and authorize the sender.',
  rejected: 'Check that GOOGLE_MAIL_SECRET matches the Apps Script property.',
  provider: 'Check the sender’s Apps Script executions or provider logs.',
} as const;
const deliveryReasons = ['url', 'permission', 'rejected', 'provider'] as const;

function accountSummary(row: AccountRow) {
  return {
    ...publicUser(row),
    active: Boolean(row.active),
    ...(row.recovery_email ? { recoveryEmailLinked: true } : {}),
    ...(row.role === 'student' && row.recovery_email && SCHOOL_EMAIL.test(row.recovery_email)
      ? { cpuEmail: row.recovery_email }
      : {}),
    ...(row.reset_requested ? { resetRequested: true } : {}),
    ...(row.reset_requested && row.reset_requested >= 2
      ? { mailIssue: mailIssues[deliveryReasons[row.reset_requested - 2]] }
      : {}),
    version: row.version,
  };
}

export function listAccounts(db: Database) {
  return db
    .all<AccountRow>(
      'SELECT username,role,active,version,is_primary,reset_requested,recovery_email FROM users ORDER BY username',
    )
    .map(accountSummary);
}

function requireManagedAccount(
  db: Database,
  actor: User,
  username: string,
  version: unknown,
): AccountRow {
  if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))
    throw new HttpError(400, 'Supply the current account version.');
  const target = db.all<AccountRow>(
    'SELECT username,role,active,version,is_primary,reset_requested,recovery_email FROM users WHERE username=?',
    username,
  )[0];
  if (!target) throw new HttpError(404, 'Account not found.');
  if (target.is_primary)
    throw new HttpError(403, 'The primary administrator account is protected.');
  if (target.role === 'admin' && !actor.isPrimary)
    throw new HttpError(403, 'Only the primary administrator can manage administrator accounts.');
  if (version !== target.version)
    throw new HttpError(409, 'Account changed. Refresh and try again.');
  return target;
}

export function manageAccount(
  db: Database,
  actor: User,
  username: string,
  version: unknown,
  update?: { role: unknown; active: unknown },
) {
  const target = requireManagedAccount(db, actor, username, version);
  if (update && typeof update.active !== 'boolean')
    throw new HttpError(400, 'Supply an active or suspended status.');
  const role = update ? accountRole(update.role) : target.role;
  const active = update?.active === true;
  if (update) requireGrantAuthority(actor, role);
  if (update && role === target.role && active === Boolean(target.active))
    return { account: accountSummary(target) };

  db.write('DELETE FROM sessions WHERE username=?', username);
  if (!update) {
    db.write('DELETE FROM student_activity WHERE username=?', username);
    db.write('DELETE FROM users WHERE username=?', username);
    return { deleted: true };
  }
  const next = {
    username,
    role,
    active,
    isPrimary: false,
    version: randomToken(),
  };
  db.write(
    'UPDATE users SET role=?,active=?,version=? WHERE username=?',
    next.role,
    Number(next.active),
    next.version,
    username,
  );
  return { account: next };
}

// Called inside the same transaction that authorizes the change.
function replacePassword(
  db: Database,
  username: string,
  credentials: { salt: string; hash: string },
) {
  const version = randomToken();
  db.write(
    'UPDATE users SET salt=?,password_hash=?,version=?,reset_requested=0 WHERE username=?',
    credentials.salt,
    credentials.hash,
    version,
    username,
  );
  db.write('DELETE FROM sessions WHERE username=?', username);
  db.write('DELETE FROM password_resets WHERE username=?', username);
  return version;
}

export async function resetAccountPassword(
  db: Database,
  username: string,
  input: Record<string, unknown>,
  requireAdmin: () => User,
) {
  requireManagedAccount(db, requireAdmin(), username, input.version);
  const { password } = validateLogin({ username, password: input.newPassword });
  const credentials = await saltedPassword(password);
  return db.atomic(() => {
    const target = requireManagedAccount(db, requireAdmin(), username, input.version);
    const version = replacePassword(db, username, credentials);
    return { account: accountSummary({ ...target, version, reset_requested: 0 }) };
  });
}

export function hasUsers(db: Database) {
  return db.all('SELECT 1 FROM users LIMIT 1').length > 0;
}

export function validSetupToken(secret?: string) {
  return typeof secret === 'string' && secret.length >= 32 && secret.length <= 256;
}

function validateLogin(input: Record<string, unknown>) {
  const { username, password } = input;
  if (
    typeof username !== 'string' ||
    !/^[A-Za-z0-9._-]{3,48}$/.test(username) ||
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 128
  ) {
    throw new HttpError(
      400,
      'Use a username of 3–48 letters, numbers, dots, hyphens or underscores and a password of 12–128 characters.',
    );
  }
  return { username: username.toLowerCase(), password };
}

function cookie(value: string, age: number) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}

export async function sessionKey(request: Request) {
  const token = request.headers
    .get('Cookie')
    ?.match(/(?:^|;\s*)__Host-course_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token ? digest(token) : undefined;
}

export function currentUser(db: Database, key: string | undefined): User | undefined {
  if (!key) return undefined;
  const row = db.all<StoredUser>(
    `SELECT u.username,u.role,u.is_primary FROM sessions s JOIN users u ON u.username=s.username
    WHERE s.digest=? AND s.expires>? AND u.active=1`,
    key,
    Date.now(),
  )[0];
  return row && publicUser(row);
}

async function makeSession() {
  const value = randomToken();
  return {
    key: await digest(value),
    cookie: cookie(value, SESSION_AGE / 1000),
  };
}

function storeSession(db: Database, username: string, key: string) {
  db.write('DELETE FROM sessions WHERE expires<=?', Date.now());
  db.write('INSERT INTO sessions VALUES (?,?,?)', key, username, Date.now() + SESSION_AGE);
}

// Cloudflare provides CF-Connecting-IP on external requests. Rate-limit before the password KDF.
export async function limitAttempts(
  db: Database,
  request: Request,
  scope?: 'student-number' | 'access-request' | 'password-recovery',
) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const bucket = await digest(scope ? scope + ':' + ip : ip);
  const now = Date.now();
  db.write('DELETE FROM attempts WHERE started<=?', now - 10 * 60_000);
  const count =
    db.all<{ count: number }>('SELECT count FROM attempts WHERE bucket=?', bucket)[0]?.count ?? 0;
  const limit = scope && scope !== 'password-recovery' ? 120 : 20;
  if (count >= limit) throw new HttpError(429, 'Too many attempts. Try again in ten minutes.');
  db.write(
    `INSERT INTO attempts VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET count=count+1`,
    bucket,
    now,
  );
  // Only failed attempts and attempts currently in flight count against the shared IP budget.
  return () =>
    db.write(
      'UPDATE attempts SET count=max(count-1,0) WHERE bucket=? AND started>?',
      bucket,
      now - 10 * 60_000,
    );
}

export async function login(db: Database, input: Record<string, unknown>) {
  const { username, password } = validateLogin(input);
  const record = db.all<Credentials>('SELECT * FROM users WHERE username=?', username)[0];
  const computed = await passwordHash(password, record?.salt ?? '0'.repeat(64));
  if (!record?.active || !equalHash(computed, record.password_hash))
    throw new HttpError(401, 'Invalid username or password.');
  const session = await makeSession();
  db.atomic(() => {
    const current = db.all<Credentials>(
      'SELECT active,version,password_hash FROM users WHERE username=?',
      username,
    )[0];
    if (
      !current?.active ||
      current.version !== record.version ||
      current.password_hash !== record.password_hash
    )
      throw new HttpError(401, 'Invalid username or password.');
    storeSession(db, username, session.key);
    if (record.role === 'student')
      db.write("INSERT INTO student_activity (username,occurred,kind) VALUES (?,?,'signin')", username, Date.now());
  });
  return { user: publicUser(record), cookie: session.cookie };
}

function invitationCode(value: string) {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

const SCHOOL_EMAIL = /^s[0-9]{7}@cpu\.edu\.hk$/;
const GOOGLE_CLIENT_ID = /^[0-9]+(?:-[a-z0-9-]+)?\.apps\.googleusercontent\.com$/i;
export const CHALLENGE_AGE = 10 * 60_000;
export type VerifyGoogle = (
  credential: string,
  clientId: string,
  nonce: string,
  expectedEmail: string,
) => Promise<void>;

export function getGoogleClientId(db: Database, fallback?: string): string {
  const saved = db.all<{ value: string }>(
    "SELECT value FROM classroom_settings WHERE name='googleClientId'",
  )[0];
  return saved?.value || (fallback && GOOGLE_CLIENT_ID.test(fallback) ? fallback : '');
}

export function setGoogleClientId(db: Database, input: unknown) {
  if (typeof input !== 'string' || input.length > 256 || !GOOGLE_CLIENT_ID.test(input.trim())) {
    throw new HttpError(
      400,
      'Enter a Google OAuth web client ID ending in .apps.googleusercontent.com.',
    );
  }
  const clientId = input.trim();
  if (getGoogleClientId(db) !== clientId) {
    db.write(
      "INSERT INTO classroom_settings(name,value) VALUES ('googleClientId',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      clientId,
    );
    db.write('DELETE FROM signup_challenges');
    db.write('DELETE FROM access_request_challenges');
  }
  return { clientId };
}

interface Grant {
  role: Role;
  issuance: string | null;
  studentEmail: string | null;
  expires: number | null;
}
interface InviteKey {
  code: string;
  hash: string;
  bootstrap: boolean;
  numberEmail?: string;
}

async function inviteKey(db: Database, input: unknown, ownerToken?: string): Promise<InviteKey> {
  if (typeof input !== 'string') throw new HttpError(403, 'Invalid or expired invitation.');
  const code = invitationCode(input);
  const bootstrap =
    !hasUsers(db) &&
    validSetupToken(ownerToken) &&
    equalHash(await digest(input), await digest(ownerToken!));
  if (!bootstrap && (!code || code.length > 256))
    throw new HttpError(403, 'Invalid or expired invitation.');
  return { code, hash: await digest(code), bootstrap };
}

export async function studentAddress(studentNumber: unknown) {
  if (typeof studentNumber !== 'string' || !/^[0-9]{7}$/.test(studentNumber)) {
    throw new HttpError(400, 'Enter the seven digits of your CPU account number.');
  }
  const email = 's' + studentNumber + '@cpu.edu.hk';
  return { studentNumber, email, emailHash: await digest(email) };
}

interface StudentInvitation {
  digest: string;
  issuance: string;
  expires: number | null;
}

const liveStudent = "role='student' AND (expires IS NULL OR expires>?)";
// Older email-as-code invitations can store only the digest of the address.
const liveStudentForAddress =
  liveStudent + ' AND (student_email=? OR (student_email IS NULL AND digest=?))';

export function studentInvitations(db: Database, email: string, emailHash: string, now: number) {
  return db.all<StudentInvitation>(
    `SELECT digest,issuance,expires FROM invites WHERE ${liveStudentForAddress}
     ORDER BY expires IS NULL DESC, expires DESC, rowid DESC`,
    now,
    email,
    emailHash,
  );
}

// Cover every live issuance. An admin reviewing one grant cannot accidentally cancel a newer one.
function registrationSignature(grants: StudentInvitation[]) {
  const parts = grants.map(({ digest, issuance, expires }) => [digest, issuance, expires] as const);
  parts.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(parts);
}

async function registrationSummary(email: string, grants: StudentInvitation[]) {
  let expires: number | null = 0;
  for (const grant of grants) {
    if (grant.expires === null) {
      expires = null;
      break;
    }
    expires = Math.max(expires, grant.expires);
  }
  return {
    studentNumber: email.slice(1, 8),
    email,
    expires,
    version: await digest(registrationSignature(grants)),
  };
}

export async function listStudentRegistrations(db: Database) {
  const byEmail = new Map<string, StudentInvitation[]>();
  const legacy = new Map<string, StudentInvitation>();
  for (const grant of db.all<StudentInvitation & { student_email: string | null }>(
    `SELECT digest,issuance,expires,student_email FROM invites WHERE ${liveStudent} ORDER BY student_email`,
    Date.now(),
  )) {
    if (grant.student_email === null) {
      legacy.set(grant.digest, grant);
    } else {
      const group = byEmail.get(grant.student_email) ?? [];
      group.push(grant);
      byEmail.set(grant.student_email, group);
    }
  }
  return Promise.all(
    Array.from(byEmail, async ([email, grants]) => {
      if (legacy.size) {
        const olderGrant = legacy.get(await digest(email));
        if (olderGrant) grants.push(olderGrant);
      }
      return registrationSummary(email, grants);
    }),
  );
}

export async function getStudentRegistration(db: Database, number: string) {
  const { email, emailHash } = await studentAddress(number);
  const grants = studentInvitations(db, email, emailHash, Date.now());
  if (!grants.length) throw new HttpError(404, 'No pending registration for that student number.');
  return registrationSummary(email, grants);
}

export async function cancelStudentRegistration(
  db: Database,
  number: string,
  version: unknown,
  requireAdmin: () => User,
) {
  if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))
    throw new HttpError(400, 'Supply the current registration version.');
  const { studentNumber, email, emailHash } = await studentAddress(number);
  const signature = registrationSignature(studentInvitations(db, email, emailHash, Date.now()));
  const expectedVersion = await digest(signature);
  return db.atomic(() => {
    requireAdmin();
    const now = Date.now();
    const current = studentInvitations(db, email, emailHash, now);
    if (!current.length)
      throw new HttpError(404, 'No pending registration for that student number.');
    if (version !== expectedVersion || registrationSignature(current) !== signature)
      throw new HttpError(409, 'Registration changed. Refresh and try again.');
    db.write(
      `DELETE FROM signup_challenges WHERE invite_digest IN (SELECT digest FROM invites WHERE ${liveStudentForAddress})`,
      now,
      email,
      emailHash,
    );
    db.write(`DELETE FROM invites WHERE ${liveStudentForAddress}`, now, email, emailHash);
    return { studentNumber, cancelled: true };
  });
}

async function signupKey(
  db: Database,
  input: Record<string, unknown>,
  stage: 'challenge' | 'register',
  ownerToken?: string,
): Promise<InviteKey> {
  if (!('studentNumber' in input)) return inviteKey(db, input.token, ownerToken);
  if ('token' in input)
    throw new HttpError(400, 'Choose a CPU account number or an invitation link.');
  const { email, emailHash } = await studentAddress(input.studentNumber);
  let hash: string | undefined;
  if (stage === 'challenge') {
    hash = studentInvitations(db, email, emailHash, Date.now())[0]?.digest;
    if (!hash)
      throw new HttpError(
        403,
        'No valid student invitation for that CPU account.',
        'student_access_required',
      );
  } else {
    // Finish the specific invitation chosen at challenge time, even if the teacher issued another.
    if (typeof input.googleNonce !== 'string' || !/^[a-f0-9]{64}$/.test(input.googleNonce)) {
      throw new HttpError(403, 'Verify your invited school account with Google to register.');
    }
    hash = db.all<{ invite_digest: string }>(
      'SELECT invite_digest FROM signup_challenges WHERE digest=? AND expires>?',
      await digest(input.googleNonce),
      Date.now(),
    )[0]?.invite_digest;
  }
  if (!hash) throw new HttpError(403, 'No valid student invitation for that CPU account.');
  return {
    code: hash === emailHash ? email : '',
    hash,
    bootstrap: false,
    numberEmail: email,
  };
}

function resolveGrant(db: Database, key: InviteKey): Grant {
  if (key.bootstrap && !hasUsers(db))
    return { role: 'admin', issuance: null, studentEmail: null, expires: 0 };
  const invite = db.all<{
    role: Role;
    issuance: string;
    student_email: string | null;
    expires: number | null;
  }>(
    "SELECT role,issuance,student_email,expires FROM invites WHERE digest=? AND ((role='student' AND expires IS NULL) OR expires>?)",
    key.hash,
    Date.now(),
  )[0];
  if (!invite) throw new HttpError(403, 'Invalid or expired invitation.');
  // Existing email-as-code invitations predate the explicit student_email column.
  const studentEmail = invite.student_email ?? (SCHOOL_EMAIL.test(key.code) ? key.code : null);
  if (key.numberEmail && (invite.role !== 'student' || studentEmail !== key.numberEmail)) {
    throw new HttpError(403, 'No valid student invitation for that CPU account.');
  }
  if (invite.role === 'student' && !studentEmail) {
    throw new HttpError(403, 'Ask your teacher for a new invitation linked to your school email.');
  }
  return {
    role: invite.role,
    issuance: invite.issuance,
    studentEmail,
    expires: invite.expires,
  };
}

export function requireClientId(db: Database, fallback?: string) {
  const id = getGoogleClientId(db, fallback);
  if (!id)
    throw new HttpError(503, 'Google verification is awaiting setup by the primary administrator.');
  return id;
}

export async function beginGoogleSignup(
  db: Database,
  input: Record<string, unknown>,
  request: Request,
  ownerToken?: string,
  fallbackClientId?: string,
) {
  const key = await signupKey(db, input, 'challenge', ownerToken);
  const nonce = randomToken();
  const nonceHash = await digest(nonce);
  const ip = await digest(request.headers.get('CF-Connecting-IP') ?? 'local');
  return db.atomic(() => {
    const grant = resolveGrant(db, key);
    if (!grant.studentEmail) return { required: false };
    const clientId = requireClientId(db, fallbackClientId);
    const now = Date.now();
    db.write('DELETE FROM signup_challenges WHERE expires<=?', now);
    const { count } = db.all<{ count: number }>(
      'SELECT count(*) AS count FROM signup_challenges WHERE ip_digest=?',
      ip,
    )[0];
    if (count >= 120)
      throw new HttpError(429, 'Too many verification requests. Try again in ten minutes.');
    db.write(
      'INSERT INTO signup_challenges (digest,invite_digest,issuance,client_id,ip_digest,expires) VALUES (?,?,?,?,?,?)',
      nonceHash,
      key.hash,
      grant.issuance!,
      clientId,
      ip,
      Math.min(grant.expires ?? Infinity, now + CHALLENGE_AGE),
    );
    return { required: true, email: grant.studentEmail, clientId, nonce };
  });
}

function requireChallenge(
  db: Database,
  nonceHash: string,
  key: InviteKey,
  grant: Grant,
  clientId: string,
) {
  const rows = db.all(
    'SELECT 1 FROM signup_challenges WHERE digest=? AND invite_digest=? AND issuance=? AND client_id=? AND expires>?',
    nonceHash,
    key.hash,
    grant.issuance,
    clientId,
    Date.now(),
  );
  if (!rows.length)
    throw new HttpError(
      403,
      'Verification expired or does not match the invitation. Verify with Google again.',
    );
}

export function schoolProof(input: Record<string, unknown>) {
  const { googleNonce, googleCredential } = input;
  if (
    typeof googleNonce !== 'string' ||
    !/^[a-f0-9]{64}$/.test(googleNonce) ||
    typeof googleCredential !== 'string' ||
    !googleCredential ||
    googleCredential.length > 8192
  )
    throw new HttpError(403, 'Verify your school Google account to continue.');
  return { googleNonce, googleCredential };
}

export async function verifySchoolProof(
  proof: ReturnType<typeof schoolProof>,
  clientId: string,
  email: string,
  verifyGoogle: VerifyGoogle = verifyGoogleStudent,
) {
  try {
    await verifyGoogle(proof.googleCredential, clientId, proof.googleNonce, email);
  } catch (error) {
    if (error instanceof GoogleIdentityError && error.status === 503)
      throw new HttpError(503, 'Google verification is temporarily unavailable. Please retry.');
    throw new HttpError(403, 'Sign in to Google with the matching school account.');
  }
}

export async function register(
  db: Database,
  input: Record<string, unknown>,
  ownerToken?: string,
  fallbackClientId?: string,
  verifyGoogle: VerifyGoogle = verifyGoogleStudent,
) {
  rejectPrimaryField(input);
  if (input.role !== undefined) accountRole(input.role);
  const { username, password } = validateLogin(input);
  const key = await signupKey(db, input, 'register', ownerToken);
  const initial = resolveGrant(db, key);
  let nonceHash = '';
  let clientId = '';
  if (initial.studentEmail) {
    clientId = requireClientId(db, fallbackClientId);
    const proof = schoolProof(input);
    nonceHash = await digest(proof.googleNonce);
    requireChallenge(db, nonceHash, key, initial, clientId);
    await verifySchoolProof(proof, clientId, initial.studentEmail, verifyGoogle);
  }
  const credentials = await saltedPassword(password);
  const session = await makeSession();
  const user = db.atomic(() => {
    const grant = resolveGrant(db, key);
    if (
      grant.issuance !== initial.issuance ||
      grant.studentEmail !== initial.studentEmail ||
      grant.role !== initial.role
    )
      throw new HttpError(403, 'Invalid or expired invitation.');
    if (grant.studentEmail) {
      if (requireClientId(db, fallbackClientId) !== clientId)
        throw new HttpError(403, 'Verification has changed. Verify with Google again.');
      requireChallenge(db, nonceHash, key, grant, clientId);
    }
    const user = {
      username,
      role: grant.role,
      isPrimary: grant.issuance === null,
    };
    insertAccount(db, user, credentials);
    if (user.role === 'student' && key.numberEmail && key.numberEmail === grant.studentEmail) {
      db.write('UPDATE users SET recovery_email=? WHERE username=?', grant.studentEmail, username);
    }
    db.write('DELETE FROM invites WHERE digest=?', key.hash);
    db.write('DELETE FROM signup_challenges WHERE invite_digest=?', key.hash);
    storeSession(db, username, session.key);
    if (user.role === 'student')
      db.write("INSERT INTO student_activity (username,occurred,kind) VALUES (?,?,'registered')", username, Date.now());
    return user;
  });
  return { user, cookie: session.cookie };
}

export async function logout(db: Database, request: Request) {
  const key = await sessionKey(request);
  if (key) db.write('DELETE FROM sessions WHERE digest=?', key);
  return cookie('', 0);
}

export function studentValidityDays(value: unknown) {
  if (value === undefined) return 14;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3650)
    throw new HttpError(400, 'Choose 1 to 3650 days or no expiry.');
  return value;
}

// A decision invalidates in-flight request proofs as well as deleting the applicant's details.
export function clearStudentAccessRequest(db: Database, studentNumber: string) {
  db.write('DELETE FROM access_request_challenges WHERE student_number=?', studentNumber);
  db.write('DELETE FROM access_requests WHERE student_number=?', studentNumber);
}

function insertInvitation(
  db: Database,
  key: string,
  role: Role,
  email: string | null,
  now: number,
  validityDays: number | null,
) {
  const expires = validityDays === null ? null : now + validityDays * 24 * HOUR;
  db.write('DELETE FROM invites WHERE expires<=?', now);
  if (db.all('SELECT 1 FROM invites WHERE digest=?', key).length)
    throw new HttpError(409, 'This invitation code already has an active invitation.');
  db.write(
    'INSERT INTO invites (digest,role,expires,issuance,student_email) VALUES (?,?,?,?,?)',
    key,
    role,
    expires,
    randomToken(),
    email,
  );
  if (role === 'student' && email) clearStudentAccessRequest(db, email.slice(1, 8));
  return expires;
}

// The caller checks administrator authority and invokes this in the same transaction.
export function authorizeStudent(
  db: Database,
  address: Awaited<ReturnType<typeof studentAddress>>,
  validityDays: number | null,
) {
  const { studentNumber, email, emailHash } = address;
  const now = Date.now();
  const existing = studentInvitations(db, email, emailHash, now)[0];
  if (existing) {
    db.write(
      "UPDATE invites SET student_email=? WHERE digest=? AND student_email IS NULL AND role='student' AND (expires IS NULL OR expires>?)",
      email,
      emailHash,
      now,
    );
    clearStudentAccessRequest(db, studentNumber);
    return { studentNumber, email, expires: existing.expires, created: false };
  }
  // Number lookup requires Google proof, so this grant needs no redeemable bearer code.
  const expires = insertInvitation(db, randomToken(), 'student', email, now, validityDays);
  return { studentNumber, email, expires, created: true };
}

export async function allowStudentRegistration(
  db: Database,
  input: Record<string, unknown>,
  requireAdmin: () => User,
) {
  if (Object.keys(input).some((field) => field !== 'studentNumber' && field !== 'validityDays'))
    throw new HttpError(400, 'Supply only the student number and registration period.');
  const validityDays = studentValidityDays(input.validityDays);
  const address = await studentAddress(input.studentNumber);
  return db.atomic(() => {
    requireAdmin();
    return authorizeStudent(db, address, validityDays);
  });
}

export async function createInvite(
  db: Database,
  requestedRole: unknown,
  requestedCode: unknown,
  requestedEmail: unknown,
  requireAdmin: () => User,
  requestedDays?: unknown,
) {
  const role = accountRole(requestedRole);
  if (requestedCode !== undefined && typeof requestedCode !== 'string')
    throw new HttpError(400, 'Invitation code must be text.');
  const token = invitationCode(requestedCode ?? '') || randomToken();
  if (token.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(token))
    throw new HttpError(400, 'Use at most 256 characters without control characters.');
  if (requestedEmail !== undefined && typeof requestedEmail !== 'string')
    throw new HttpError(400, 'Enter the invited student’s school email address.');
  const addressCode = /^[^\s@]+@[^\s@]+$/.test(token);
  const explicitEmail =
    typeof requestedEmail === 'string' ? requestedEmail.trim().toLowerCase() : '';
  const studentEmail = explicitEmail || (SCHOOL_EMAIL.test(token) ? token : null);
  if ((role === 'student' || explicitEmail) && (!studentEmail || !SCHOOL_EMAIL.test(studentEmail)))
    throw new HttpError(
      400,
      'Use the student’s school Google address, such as s1234567@cpu.edu.hk.',
    );
  if (studentEmail && addressCode && token !== studentEmail)
    throw new HttpError(400, 'The invitation email and the student’s school address must match.');
  const key = await digest(token);
  return db.atomic(() => {
    requireGrantAuthority(requireAdmin(), role);
    if (role === 'admin' && requestedDays !== undefined)
      throw new HttpError(400, 'Administrator invitations are valid for 24 hours.');
    const days = role === 'student' ? studentValidityDays(requestedDays) : 1;
    const expires = insertInvitation(db, key, role, studentEmail, Date.now(), days);
    return { token, expires };
  });
}

export async function changePassword(
  db: Database,
  user: User,
  input: Record<string, unknown>,
  key: string | undefined,
) {
  const { password: nextPassword } = validateLogin({
    username: user.username,
    password: input.newPassword,
  });
  const { password } = validateLogin({
    username: user.username,
    password: input.currentPassword,
  });
  const record = db.all<Credentials>('SELECT * FROM users WHERE username=?', user.username)[0];
  if (
    !record?.active ||
    !equalHash(await passwordHash(password, record.salt), record.password_hash)
  ) {
    throw new HttpError(403, 'The current password is incorrect.');
  }
  const credentials = await saltedPassword(nextPassword);
  const session = await makeSession();
  db.atomic(() => {
    if (!currentUser(db, key)) throw new HttpError(401, 'Please sign in again.');
    const current = db.all<Credentials>(
      'SELECT password_hash FROM users WHERE username=?',
      user.username,
    )[0];
    if (current?.password_hash !== record.password_hash)
      throw new HttpError(409, 'Password changed. Please sign in again.');
    replacePassword(db, user.username, credentials);
    storeSession(db, user.username, session.key);
  });
  return { user, cookie: session.cookie };
}

type ResetMessage = { email: string; username: string; token: string };
export type SendReset = (message: ResetMessage) => Promise<void>;

const resetLifetime = 30 * 60_000;

export async function requestPasswordRecovery(db: Database, name: unknown, send?: SendReset) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{3,48}$/.test(name))
    throw new HttpError(400, 'Enter your classroom username.');
  const username = name.toLowerCase();
  const token = randomToken();
  const hash = await digest(token);
  const delivery = db.atomic(() => {
    const now = Date.now();
    db.write('DELETE FROM password_resets WHERE created<=?', now - resetLifetime);
    const row = db.all<{ role: Role; recovery_email: string | null; version: string }>(
      'SELECT role,recovery_email,version FROM users WHERE username=? AND is_primary=0 AND active=1',
      username,
    )[0];
    if (!row) return;
    if (!send || row.role !== 'student' || !row.recovery_email) {
      db.write('UPDATE users SET reset_requested=1 WHERE username=?', username);
      return;
    }
    if (
      db.all(
        'SELECT 1 FROM password_resets WHERE username=? AND version=? AND created>?',
        username,
        row.version,
        now - 5 * 60_000,
      ).length
    )
      return;
    db.write('INSERT INTO password_resets VALUES (?,?,?,?)', hash, username, row.version, now);
    return { email: row.recovery_email, version: row.version };
  });
  if (delivery && send) {
    try {
      await send({ email: delivery.email, username, token });
      db.write(
        'UPDATE users SET reset_requested=0 WHERE username=? AND version=?',
        username,
        delivery.version,
      );
    } catch (err) {
      const reason = err instanceof MailDeliveryError ? err.reason : 'provider';
      db.atomic(() => {
        // The provider may have accepted the email before its reply was lost.
        if (reason !== 'provider') db.write('DELETE FROM password_resets WHERE digest=?', hash);
        db.write(
          'UPDATE users SET reset_requested=? WHERE username=? AND version=?',
          2 + deliveryReasons.indexOf(reason),
          username,
          delivery.version,
        );
      });
      console.error('Classroom password reset delivery failed; manual review requested.');
    }
  }
}

export async function redeemPasswordReset(db: Database, input: Record<string, unknown>) {
  const invalid = () =>
    new HttpError(403, 'This reset link is invalid or has expired. Request a new one.');
  if (typeof input.token !== 'string' || !/^[0-9a-f]{64}$/.test(input.token)) throw invalid();
  const hash = await digest(input.token);
  function target() {
    const row = db.all<{ username: string }>(
      `SELECT u.username FROM password_resets r
      JOIN users u ON u.username=r.username AND u.version=r.version
      WHERE r.digest=? AND r.created>? AND u.active=1 AND u.role='student' AND u.recovery_email IS NOT NULL`,
      hash,
      Date.now() - resetLifetime,
    )[0];
    if (!row) throw invalid();
    return row.username;
  }
  const { password } = validateLogin({ username: target(), password: input.newPassword });
  const credentials = await saltedPassword(password);
  db.atomic(() => replacePassword(db, target(), credentials));
}
