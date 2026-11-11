import test from 'node:test';
import { createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CourseApi } from '../worker/api.ts';
import type { Database } from '../worker/storage.ts';
import { initialize, readPart, storePart } from '../worker/storage.ts';

const origin = 'https://classroom.example';
const adminToken = 'unit-test-fixture-for-owner-bootstrap';
const account = { username: 'tutor', password: 'unit test password' };
const studentEmail = 's1234567@cpu.edu.hk';
const classmateEmail = 's7654321@cpu.edu.hk';
const day = 24 * 60 * 60 * 1000;
const testClientId = '12345-test.apps.googleusercontent.com';
const text = (value: string) => ({ kind: 'text', value });
const lesson = {
  format: 'cpu-lesson-v1',
  id: 'test-set',
  title: 'Public test vectors',
  questions: [
    {
      id: 'test-q',
      title: 'Question',
      topic: 'Test',
      difficulty: 'Test',
      statement: [text('QUESTION-ONLY')],
    },
  ],
  solutions: [
    {
      id: 'test-q',
      hints: [[text('HINT-ONLY')]],
      steps: [text('SOLUTION-ONLY')],
      answer: [text('ANSWER-ONLY')],
    },
  ],
};

function fixture(
  secret = adminToken,
  prepare?: (db: Database) => void,
  legacyPrimaryUsername?: string,
  clientId: string = testClientId,
  sendReset?: import('../worker/security.ts').SendReset,
) {
  const sqlite = new DatabaseSync(':memory:');
  const db: Database = {
    all: <T extends object>(query: string, ...values: (string | number | ArrayBuffer | null)[]) =>
      sqlite
        .prepare(query)
        .all(...values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v))) as T[],
    write(query, ...values) {
      sqlite
        .prepare(query)
        .run(...values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)));
    },
    atomic<T>(action: () => T) {
      sqlite.exec('BEGIN');
      try {
        const value = action();
        sqlite.exec('COMMIT');
        return value;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  prepare?.(db);
  // Treat issued credentials as opaque here. The verifier's cryptography has separate tests.
  const credentials = new Map<string, { email: string; audience: string; nonce: string }>();
  function credential(email: string, nonce: string, audience = clientId) {
    const value = randomUUID();
    credentials.set(value, { email, audience, nonce });
    return value;
  }
  async function verifyGoogle(value: string, audience: string, nonce: string, expected: string) {
    const claims = credentials.get(value);
    if (
      !claims ||
      claims.email !== expected ||
      claims.nonce !== nonce ||
      claims.audience !== audience
    ) {
      throw new Error('Google identity does not match.');
    }
  }
  const api = new CourseApi(db, secret, legacyPrimaryUsername, clientId, verifyGoogle, sendReset);
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = '',
    headers: Record<string, string> = {},
  ) {
    return api.fetch(
      new Request(origin + '/api/' + path, {
        method,
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
  }
  async function bootstrap() {
    return cookieOf(await call('register', 'POST', { ...account, token: secret }));
  }
  async function challenge(token: string) {
    const response = await call('signup/google/challenge', 'POST', { token });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.required, true);
    assert.ok(typeof payload.nonce === 'string' && payload.nonce.length >= 32);
    return payload as { required: true; nonce: string; email: string; clientId: string };
  }
  async function proof(token: string, email = studentEmail) {
    const { nonce, clientId: audience } = await challenge(token);
    return { googleNonce: nonce, googleCredential: credential(email, nonce, audience) };
  }
  async function accessProof(studentNumber: string) {
    const response = await call('access-requests/challenge', 'POST', { studentNumber });
    assert.equal(response.status, 200);
    const { required, nonce, email, clientId: audience } = await response.json();
    assert.equal(required, true);
    assert.equal(email, 's' + studentNumber + '@cpu.edu.hk');
    assert.match(nonce, /^[a-f0-9]{64}$/);
    return { googleNonce: nonce, googleCredential: credential(email, nonce, audience) };
  }
  return { api, db, call, bootstrap, challenge, proof, credential, accessProof };
}

function cookieOf(response: Response) {
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie?.includes('HttpOnly; Secure; SameSite=Strict'));
  return cookie!.split(';')[0];
}

test('unconfigured or spent bootstrap fails closed; invites are single-use and cannot choose own role', async () => {
  const unconfigured = fixture('');
  assert.equal((await (await unconfigured.call('session')).json()).setupRequired, false);
  assert.equal(
    (await unconfigured.call('register', 'POST', { ...account, token: 'guess' })).status,
    403,
  );
  const { call, bootstrap, proof } = fixture();
  const admin = await bootstrap();
  assert.equal((await call('register', 'POST', { ...account, token: adminToken })).status, 403);
  const invite = await (
    await call('invites', 'POST', { role: 'student', studentEmail }, admin)
  ).json();
  const user = {
    username: 'student',
    password: account.password,
    token: invite.token,
    ...(await proof(invite.token)),
    role: 'admin',
  };
  const registrations = await Promise.all([
    call('register', 'POST', user),
    call('register', 'POST', user),
  ]);
  assert.deepEqual(registrations.map((r) => r.status).sort(), [200, 403]);
  const student = cookieOf(registrations.find((r) => r.status === 200)!);
  assert.equal(
    (await (await call('session', 'GET', undefined, student)).json()).user.role,
    'student',
  );
  assert.equal((await call('invites', 'POST', { role: 'admin' }, student)).status, 403);
  assert.equal((await call('sets', 'POST', lesson, student)).status, 403);
  assert.equal(
    (await call('sets', 'POST', lesson, admin, { Origin: 'https://outside.example' })).status,
    403,
  );
});

test('the primary administrator creates working accounts of either role and keeps their own session', async () => {
  const { call, bootstrap } = fixture();
  const owner = await bootstrap();
  for (const role of ['student', 'admin']) {
    const username = 'new-' + role;
    const credentials = { username, password: 'unit test initial password' };
    const newAccount = { ...credentials, role };
    const created = await call('accounts', 'POST', newAccount, owner);
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { user: { username, role, isPrimary: false } });
    assert.equal(created.headers.has('Set-Cookie'), false);
    const session = await (await call('session', 'GET', undefined, owner)).json();
    assert.deepEqual(session.user, { username: account.username, role: 'admin', isPrimary: true });

    const newCookie = cookieOf(await call('login', 'POST', credentials));
    const signedIn = await (await call('session', 'GET', undefined, newCookie)).json();
    assert.deepEqual(signedIn.user, { username, role, isPrimary: false });
    const invite = await call('invites', 'POST', { role: 'student', studentEmail }, newCookie);
    assert.equal(invite.status, role === 'admin' ? 201 : 403);
    if (role === 'student') {
      const elevated = { ...newAccount, username: 'another-teacher', role: 'admin' };
      assert.equal((await call('accounts', 'POST', elevated, newCookie)).status, 403);
    }
  }
});

test('account creation rejects unauthorised requests, invalid credentials and duplicate names', async () => {
  const { call, bootstrap } = fixture();
  const owner = await bootstrap();
  const input = { username: 'reader', password: 'initial unit test password', role: 'student' };
  assert.equal((await call('accounts', 'POST', input)).status, 401);
  assert.equal(
    (await call('accounts', 'POST', input, owner, { Origin: 'https://outside.example' })).status,
    403,
  );
  for (const invalid of [{ role: 'teacher' }, { username: 'x' }, { password: 'short' }]) {
    assert.equal((await call('accounts', 'POST', { ...input, ...invalid }, owner)).status, 400);
  }

  const results = await Promise.all([
    call('accounts', 'POST', input, owner),
    call('accounts', 'POST', { ...input, username: 'READER' }, owner),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const overwrite = { ...input, username: account.username.toUpperCase(), role: 'student' };
  assert.equal((await call('accounts', 'POST', overwrite, owner)).status, 409);
  const originalOwner = cookieOf(await call('login', 'POST', account));
  assert.equal(
    (await (await call('session', 'GET', undefined, originalOwner)).json()).user.role,
    'admin',
  );
});

test('hidden content is filtered server-side on every read and replacement starts private', async () => {
  const { call, bootstrap, proof } = fixture();
  const admin = await bootstrap();
  const { token } = await (
    await call('invites', 'POST', { role: 'student', studentEmail }, admin)
  ).json();
  const student = cookieOf(
    await call('register', 'POST', {
      ...account,
      username: 'reader',
      token,
      ...(await proof(token)),
    }),
  );
  const list = () => call('sets', 'GET', undefined, student);
  const get = () => call('sets/test-set', 'GET', undefined, student);
  const release = (revision: number, q: boolean, s: boolean) =>
    call('sets/test-set', 'PATCH', { revision, questionsVisible: q, solutionsVisible: s }, admin);
  assert.equal((await call('sets', 'GET')).status, 401);
  assert.equal((await call('sets', 'POST', lesson, admin)).status, 201);
  assert.equal((await get()).status, 404);
  assert.deepEqual((await (await list()).json()).sets, []);
  assert.equal((await call('sets/test-set', 'GET', undefined, admin)).status, 200);
  assert.equal((await release(1, true, false)).status, 200);
  const q = await get();
  assert.match(q.headers.get('Cache-Control')!, /no-store/);
  const qs = await q.text();
  assert.match(qs, /QUESTION-ONLY/);
  assert.doesNotMatch(qs, /HINT-ONLY|SOLUTION-ONLY|ANSWER-ONLY/);
  assert.equal((await release(1, true, true)).status, 409);
  assert.equal((await release(2, false, true)).status, 200);
  const sol = await (await get()).text();
  assert.match(sol, /ANSWER-ONLY/);
  assert.doesNotMatch(sol, /QUESTION-ONLY/);
  assert.equal((await release(3, true, true)).status, 200);
  assert.equal((await call('sets', 'POST', lesson, admin)).status, 409);
  assert.equal((await call('sets', 'POST', lesson, admin, { 'If-Match': '"4"' })).status, 200);
  assert.equal((await get()).status, 404);
  assert.equal(
    (
      await call(
        'sets/test-set',
        'PATCH',
        { revision: 5, questionsVisible: true, solutionsVisible: true },
        student,
      )
    ).status,
    403,
  );
  assert.equal((await call('sets', 'POST', { ...lesson, format: 'other' }, admin)).status, 422);
});

test('admins edit released sets atomically at the current revision and retain visibility', async () => {
  const { bootstrap, call } = fixture();
  const owner = await bootstrap();
  async function create(role: 'admin' | 'student') {
    const login = { username: 'edit-' + role, password: account.password };
    await call('accounts', 'POST', { ...login, role }, owner);
    return cookieOf(await call('login', 'POST', login));
  }
  const teacher = await create('admin');
  const student = await create('student');
  const path = 'sets/' + lesson.id;
  await call('sets', 'POST', lesson, owner);
  await call(path, 'PATCH', { revision: 1, questionsVisible: true, solutionsVisible: false }, owner);
  const changed = { ...lesson, title: 'Revised title',
    questions: [{ ...lesson.questions[0], statement: [text('New statement')] }],
    solutions: [{ ...lesson.solutions[0], answer: [text('New answer')] }],
  };
  const edit = (cookie: string, body: unknown, revision = 2) =>
    call(path, 'PUT', body, cookie, { 'If-Match': '"' + revision + '"' });
  assert.equal((await edit('', changed)).status, 401);
  assert.equal((await edit(student, changed)).status, 403);
  assert.equal((await edit(teacher, { ...changed, solutions: [] })).status, 422);
  assert.equal((await edit(teacher, { ...changed, id: 'other' })).status, 400);
  assert.equal((await call(path, 'PUT', changed, teacher)).status, 409);
  assert.equal((await edit(teacher, changed)).status, 200);
  assert.equal((await edit(owner, lesson)).status, 409);
  const detail = await (await call(path, 'GET', undefined, owner)).json();
  assert.deepEqual(detail.package, changed);
  assert.deepEqual(detail.set, { id: lesson.id, title: changed.title, revision: 3,
    questionsVisible: true, solutionsVisible: false });
  const released = await (await call(path, 'GET', undefined, student)).json();
  assert.deepEqual(released.package, { ...changed, solutions: [] });
  assert.equal((await call('sets/missing', 'PUT', { ...changed, id: 'missing' }, owner)).status, 404);
});

test('password rotation and logout revoke cookies; invalid credentials are throttled', async () => {
  const { call, bootstrap } = fixture();
  const first = await bootstrap();
  const second = cookieOf(await call('login', 'POST', account));
  const next = { currentPassword: account.password, newPassword: 'a new unit test password' };
  assert.equal(
    (await call('password', 'POST', { ...next, currentPassword: 'different old password' }, first))
      .status,
    403,
  );
  const replacement = cookieOf(await call('password', 'POST', next, first));
  for (const old of [first, second])
    assert.equal((await (await call('session', 'GET', undefined, old)).json()).user, null);
  assert.equal(
    (await (await call('session', 'GET', undefined, replacement)).json()).user.username,
    account.username,
  );
  assert.equal((await call('login', 'POST', account)).status, 401);
  assert.equal((await call('logout', 'POST', {}, replacement)).status, 200);
  assert.equal((await (await call('session', 'GET', undefined, replacement)).json()).user, null);
  const address = { 'CF-Connecting-IP': '192.0.2.1' };
  for (let i = 0; i < 20; i++) {
    assert.equal(
      (await call('register', 'POST', { ...account, token: 'bad' }, '', address)).status,
      403,
    );
  }
  assert.equal((await call('login', 'POST', account, '', address)).status, 429);
});

test('large UTF-8 content round-trips through bounded SQLite rows', () => {
  const { db } = fixture();
  const content = ['🌊'.repeat(160000), '終'];
  db.atomic(() => storePart(db, 'unicode', 'questions', content));
  assert.deepEqual(readPart(db, 'unicode', 'questions'), content);
  const chunks = db.all<{ n: number }>(
    'SELECT length(bytes) AS n FROM content WHERE id=?',
    'unicode',
  );
  assert.ok(chunks.length > 1 && chunks.every((row) => row.n <= 256 * 1024));
});

test('legacy migration protects the original owner and invalidates old admin invitations exactly once', async () => {
  const hash = pbkdf2Sync(account.password, 'legacy salt', 100_000, 32, 'sha256').toString('hex');
  const { db, call } = fixture(
    adminToken,
    (db) => {
      db.write(
        'CREATE TABLE users (username TEXT PRIMARY KEY,salt TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL)',
      );
      // The first bootstrap account precedes all invited or directly created accounts.
      for (const [username, role] of [
        [account.username, 'admin'],
        ['second-admin', 'admin'],
        ['reader', 'student'],
      ]) {
        db.write('INSERT INTO users VALUES (?,?,?,?)', username, 'legacy salt', hash, role);
      }
      db.write(
        'CREATE TABLE invites (digest TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL)',
      );
      for (const role of ['student', 'admin']) {
        const digest = createHash('sha256')
          .update('pre-migration-' + role)
          .digest('hex');
        db.write('INSERT INTO invites VALUES (?,?,?)', digest, role, Date.now() + 600_000);
      }
    },
    account.username,
  );
  const owner = cookieOf(await call('login', 'POST', account));
  const list = async () =>
    (await (await call('accounts', 'GET', undefined, owner)).json()).accounts;
  const accounts = await list();
  assert.deepEqual(
    accounts.map((u: { username: string }) => u.username),
    ['reader', 'second-admin', account.username],
  );
  for (const row of accounts) {
    assert.deepEqual(Object.keys(row).sort(), [
      'active',
      'isPrimary',
      'role',
      'username',
      'version',
    ]);
    assert.equal(row.active, true);
    assert.equal(row.isPrimary, row.username === account.username);
    assert.ok(row.version);
  }
  assert.equal(new Set(accounts.map((u: { version: string }) => u.version)).size, accounts.length);
  const register = (username: string, token: string) =>
    call('register', 'POST', { username, password: account.password, token });
  assert.equal((await register('old-admin', 'pre-migration-admin')).status, 403);
  const fresh = await (await call('invites', 'POST', { role: 'admin' }, owner)).json();
  new CourseApi(db, adminToken, account.username);
  assert.deepEqual(await list(), accounts);
  assert.equal((await register('new-reader', 'pre-migration-student')).status, 403);
  const invited = await (await register('invited-admin', fresh.token)).json();
  assert.deepEqual(invited.user, { username: 'invited-admin', role: 'admin', isPrimary: false });
});

test('a deleted and later recreated legacy owner is never automatically elevated', async () => {
  const hash = pbkdf2Sync(account.password, 'legacy salt', 100_000, 32, 'sha256').toString('hex');
  const { call } = fixture(
    adminToken,
    (db) => {
      db.write(
        'CREATE TABLE users (username TEXT PRIMARY KEY,salt TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL)',
      );
      for (const name of [account.username, 'peer-admin']) {
        db.write('INSERT INTO users VALUES (?,?,?,?)', name, 'legacy salt', hash, 'admin');
      }
      db.write('DELETE FROM users WHERE username=?', account.username);
      db.write(
        'INSERT INTO users VALUES (?,?,?,?)',
        account.username,
        'legacy salt',
        hash,
        'admin',
      );
    },
    account.username,
  );
  const login = await call('login', 'POST', account);
  const ordinary = cookieOf(login);
  assert.equal((await login.json()).user.isPrimary, false);
  const { accounts } = await (await call('accounts', 'GET', undefined, ordinary)).json();
  assert.ok(accounts.every((row: { isPrimary: boolean }) => row.isPrimary === false));
  assert.equal((await call('invites', 'POST', { role: 'admin' }, ordinary)).status, 403);
});

test('account changes enforce student access, revoke sessions and reject stale writes after recreation', async () => {
  const { call, bootstrap } = fixture();
  const owner = await bootstrap();
  const credentials = { username: 'learner', password: 'student test password' };
  const path = 'accounts/learner';
  const create = () => call('accounts', 'POST', { ...credentials, role: 'student' }, owner);
  assert.equal((await create()).status, 201);
  const list = async () =>
    (await (await call('accounts', 'GET', undefined, owner)).json()).accounts;
  const lookup = async () =>
    (await list()).find((a: { username: string }) => a.username === credentials.username);
  const login = async () => cookieOf(await call('login', 'POST', credentials));
  const session = async (cookie: string) =>
    (await (await call('session', 'GET', undefined, cookie)).json()).user;
  const first = await lookup();
  const student = await login();
  const promote = { version: first.version, role: 'admin', active: true };
  assert.equal((await call('accounts')).status, 401);
  assert.equal((await call('accounts', 'GET', undefined, student)).status, 403);
  assert.equal((await call(path, 'PATCH', promote, student)).status, 403);
  assert.equal((await call(path, 'DELETE', { version: first.version }, student)).status, 403);
  assert.equal(
    (await call(path, 'PATCH', promote, owner, { Origin: 'https://outside.example' })).status,
    403,
  );
  assert.equal((await call(path, 'PATCH', { ...promote, active: 1 }, owner)).status, 400);
  assert.equal((await call(path, 'PATCH', { ...promote, role: 'teacher' }, owner)).status, 400);
  const promoted = await (await call(path, 'PATCH', promote, owner)).json();
  assert.equal(promoted.account.role, 'admin');
  assert.notEqual(promoted.account.version, first.version);
  assert.equal(await session(student), null);
  assert.equal((await call(path, 'DELETE', { version: first.version }, owner)).status, 409);
  const admin = await login();
  const actions = [
    { active: false, role: 'student' },
    { active: true, role: 'student' },
  ];
  for (const change of actions) {
    const row = await lookup();
    const res = await call(path, 'PATCH', { ...change, version: row.version }, owner);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).account.active, change.active);
    assert.equal(await session(admin), null);
    assert.equal((await call('login', 'POST', credentials)).status, change.active ? 200 : 401);
  }
  const beforeRemoval = await lookup();
  const lastSession = await login();
  assert.deepEqual(
    await (await call(path, 'DELETE', { version: beforeRemoval.version }, owner)).json(),
    { deleted: true },
  );
  assert.equal(await lookup(), undefined);
  assert.equal(await session(lastSession), null);
  assert.equal((await call('login', 'POST', credentials)).status, 401);
  assert.equal((await create()).status, 201);
  const replacement = await lookup();
  assert.notEqual(replacement.version, beforeRemoval.version);
  assert.equal((await call(path, 'DELETE', { version: beforeRemoval.version }, owner)).status, 409);
  assert.equal(await session(lastSession), null);
});

test('only one concurrent bootstrap registration can become primary', async () => {
  const { call } = fixture();
  const results = await Promise.all(
    ['first-teacher', 'other-teacher'].map((username) =>
      call('register', 'POST', { username, password: account.password, token: adminToken }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
  const successful = results.find((r) => r.ok)!;
  const owner = cookieOf(successful);
  const { user } = await successful.json();
  assert.equal(user.isPrimary, true);
  const { accounts } = await (await call('accounts', 'GET', undefined, owner)).json();
  assert.deepEqual(
    accounts.map((row: { username: string; isPrimary: boolean }) => [row.username, row.isPrimary]),
    [[user.username, true]],
  );
});

test('only the primary administrator can grant access to or manage an administrator account', async () => {
  const { call, bootstrap } = fixture();
  const owner = await bootstrap();
  const create = (
    username: string,
    role: string,
    cookie: string,
    extra: Record<string, unknown> = {},
  ) => call('accounts', 'POST', { username, password: account.password, role, ...extra }, cookie);
  const lookup = async (username: string) => {
    const { accounts } = await (await call('accounts', 'GET', undefined, owner)).json();
    return accounts.find((row: { username: string }) => row.username === username);
  };
  const patch = async (
    name: string,
    role: string,
    active: boolean,
    cookie: string,
    extra: Record<string, unknown> = {},
  ) =>
    call(
      'accounts/' + name,
      'PATCH',
      { version: (await lookup(name)).version, role, active, ...extra },
      cookie,
    );
  const remove = async (name: string, cookie: string) =>
    call('accounts/' + name, 'DELETE', { version: (await lookup(name)).version }, cookie);
  await create('ordinary', 'admin', owner);
  const admin = cookieOf(
    await call('login', 'POST', { username: 'ordinary', password: account.password }),
  );
  assert.equal((await create('classmate', 'student', admin)).status, 201);
  assert.equal(
    (await call('invites', 'POST', { role: 'student', studentEmail }, admin)).status,
    201,
  );
  assert.equal((await call('sets', 'POST', lesson, admin)).status, 201);

  assert.equal((await create('another-admin', 'admin', admin)).status, 403);
  assert.equal((await call('invites', 'POST', { role: 'admin' }, admin)).status, 403);
  assert.equal((await patch('classmate', 'admin', true, admin)).status, 403);
  assert.equal((await patch('classmate', 'student', false, admin)).status, 200);
  assert.equal((await patch('classmate', 'student', true, admin)).status, 200);
  assert.equal((await remove('classmate', admin)).status, 200);

  for (const actor of [owner, admin]) {
    assert.equal((await patch(account.username, 'admin', false, actor)).status, 403);
    assert.equal((await patch(account.username, 'student', true, actor)).status, 403);
    assert.equal((await remove(account.username, actor)).status, 403);
  }
  await create('peer', 'admin', owner);
  for (const [role, active] of [
    ['admin', true],
    ['admin', false],
    ['student', true],
    ['student', false],
  ] as const) {
    assert.equal((await patch('peer', role, active, admin)).status, 403);
  }
  assert.equal((await remove('peer', admin)).status, 403);
  assert.equal((await patch('peer', 'admin', false, owner)).status, 200);
  assert.equal((await patch('peer', 'admin', true, admin)).status, 403);
  assert.equal((await patch('peer', 'admin', true, owner)).status, 200);
  assert.equal((await patch('peer', 'student', true, owner)).status, 200);
  assert.equal((await patch('peer', 'admin', true, admin)).status, 403);
  assert.equal((await patch('peer', 'admin', true, owner)).status, 200);
  assert.equal((await remove('peer', owner)).status, 200);
});

test('clients cannot create or promote a primary administrator through a claimed role or flag', async () => {
  const { call, bootstrap, proof } = fixture();
  const owner = await bootstrap();
  const credentials = { username: 'future-admin', password: account.password };
  const invite = await (
    await call('invites', 'POST', { role: 'student', studentEmail }, owner)
  ).json();
  const register = await call('register', 'POST', {
    ...credentials,
    token: invite.token,
    isPrimary: true,
  });
  assert.equal(register.status, 400);
  for (const privilege of [{ role: 'primary' }, { role: 'admin', isPrimary: true }]) {
    assert.equal(
      (await call('accounts', 'POST', { ...credentials, ...privilege }, owner)).status,
      400,
    );
    assert.equal((await call('invites', 'POST', privilege, owner)).status, 400);
  }
  cookieOf(
    await call('register', 'POST', {
      ...credentials,
      token: invite.token,
      ...(await proof(invite.token)),
    }),
  );
  const { accounts } = await (await call('accounts', 'GET', undefined, owner)).json();
  const student = accounts.find(
    (row: { username: string }) => row.username === credentials.username,
  );
  for (const privilege of [{ role: 'primary' }, { role: 'admin', isPrimary: true }]) {
    assert.equal(
      (
        await call(
          'accounts/' + credentials.username,
          'PATCH',
          { active: true, version: student.version, ...privilege },
          owner,
        )
      ).status,
      400,
    );
  }
  assert.equal((await (await call('login', 'POST', credentials)).json()).user.isPrimary, false);
  const rotated = await call(
    'password',
    'POST',
    { currentPassword: account.password, newPassword: 'replacement primary password' },
    owner,
  );
  const session = await (await call('session', 'GET', undefined, cookieOf(rotated))).json();
  assert.deepEqual(session.user, { username: account.username, role: 'admin', isPrimary: true });
});

test('password reset follows the administrator hierarchy and revokes only the target sessions', async () => {
  const { call, bootstrap } = fixture();
  const primary = await bootstrap();
  const startPassword = 'initial test password';
  const firstReset = 'replacement test password';
  const secondReset = 'another replacement password';
  for (const [username, role] of [
    ['teacher', 'admin'],
    ['peer', 'admin'],
    ['learner', 'student'],
  ]) {
    assert.equal(
      (await call('accounts', 'POST', { username, role, password: startPassword }, primary)).status,
      201,
    );
  }
  async function lookup(name: string) {
    const { accounts } = await (await call('accounts', 'GET', undefined, primary)).json();
    return accounts.find((row: { username: string }) => row.username === name);
  }
  const login = (username: string, password: string) =>
    call('login', 'POST', { username, password });
  const reset = (actor: string, username: string, version: string, newPassword = firstReset) =>
    call('accounts/' + username + '/password', 'POST', { version, newPassword }, actor);
  const teacher = cookieOf(await login('teacher', startPassword));
  const student = cookieOf(await login('learner', startPassword));
  const otherStudentSession = cookieOf(await login('learner', startPassword));
  const learner = await lookup('learner');
  assert.equal((await reset('', 'learner', learner.version)).status, 401);
  assert.equal((await reset(student, 'learner', learner.version)).status, 403);
  for (const [actor, target] of [
    [teacher, 'peer'],
    [teacher, 'teacher'],
    [teacher, account.username],
    [primary, account.username],
  ]) {
    assert.equal((await reset(actor, target, (await lookup(target)).version)).status, 403);
  }
  assert.equal((await reset(primary, 'learner', learner.version, 'short')).status, 400);
  assert.equal((await reset(primary, 'learner', 'bad-version')).status, 400);
  assert.equal(
    (
      await call(
        'accounts/learner/password',
        'POST',
        { version: learner.version, newPassword: firstReset },
        teacher,
        { Origin: 'https://outside.example' },
      )
    ).status,
    403,
  );
  assert.deepEqual(await lookup('learner'), learner);

  const changed = await reset(teacher, 'learner', learner.version);
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.has('Set-Cookie'), false);
  const row = await lookup('learner');
  assert.notEqual(row.version, learner.version);
  assert.deepEqual(row, { ...learner, version: row.version });
  assert.deepEqual(await changed.json(), { account: row });
  for (const cookie of [student, otherStudentSession]) {
    assert.equal((await call('sets', 'GET', undefined, cookie)).status, 401);
  }
  assert.equal((await call('accounts', 'GET', undefined, teacher)).status, 200);
  assert.equal((await reset(primary, 'learner', learner.version, secondReset)).status, 409);
  assert.equal((await login('learner', startPassword)).status, 401);
  cookieOf(await login('learner', firstReset));

  assert.equal((await reset(primary, 'learner', row.version, secondReset)).status, 200);
  cookieOf(await login('learner', secondReset));
  assert.equal((await reset(primary, 'teacher', (await lookup('teacher')).version)).status, 200);
  assert.equal((await call('accounts', 'GET', undefined, teacher)).status, 401);
  assert.equal((await login('teacher', startPassword)).status, 401);
  const newTeacher = cookieOf(await login('teacher', firstReset));
  assert.equal((await call('accounts', 'GET', undefined, newTeacher)).status, 200);
});

test('an account reset respects suspension and detects an intervening personal password change', async () => {
  const { call, bootstrap } = fixture();
  const primary = await bootstrap();
  const student = { username: 'student', password: 'initial learner password' };
  await call('accounts', 'POST', { ...student, role: 'student' }, primary);
  const list = async () =>
    (await (await call('accounts', 'GET', undefined, primary)).json()).accounts;
  const original = (await list()).find(
    (row: { username: string }) => row.username === student.username,
  );
  const cookie = cookieOf(await call('login', 'POST', student));
  const personalPassword = 'password chosen by learner';
  const newSession = cookieOf(
    await call(
      'password',
      'POST',
      { currentPassword: student.password, newPassword: personalPassword },
      cookie,
    ),
  );
  const resetPassword = 'replacement for learner';
  const path = 'accounts/' + student.username;
  const reset = (version: string) =>
    call(path + '/password', 'POST', { version, newPassword: resetPassword }, primary);
  assert.equal((await reset(original.version)).status, 409);
  assert.equal((await call('sets', 'GET', undefined, newSession)).status, 200);
  const current = (await list()).find(
    (row: { username: string }) => row.username === student.username,
  );
  const access = (version: string, active: boolean) =>
    call(path, 'PATCH', { version, role: 'student', active }, primary);
  const suspended = (await (await access(current.version, false)).json()).account;
  const response = await reset(suspended.version);
  assert.equal(response.status, 200);
  const { account: change } = await response.json();
  assert.equal(change.active, false);
  const login = (password: string) =>
    call('login', 'POST', { username: student.username, password });
  assert.equal((await login(resetPassword)).status, 401);
  assert.equal((await access(change.version, true)).status, 200);
  assert.equal((await login(personalPassword)).status, 401);
  cookieOf(await login(resetPassword));
});

test('a school email invitation can be claimed by its verified student once through a code or link', async () => {
  const { call, bootstrap, proof } = fixture();
  const primary = await bootstrap();
  const credentials = { username: 'teacher', password: account.password };
  assert.equal(
    (await call('accounts', 'POST', { ...credentials, role: 'admin' }, primary)).status,
    201,
  );
  const teacher = cookieOf(await call('login', 'POST', credentials));

  const address = studentEmail.toUpperCase();
  const start = Date.now();
  const issued = await Promise.all([
    call('invites', 'POST', { role: 'student', code: ' ' + address + ' ' }, teacher),
    call('invites', 'POST', { role: 'student', code: address.toLowerCase() }, teacher),
  ]);
  assert.deepEqual(issued.map((r) => r.status).sort(), [201, 409]);
  const { token, expires } = await issued.find((r) => r.status === 201)!.json();
  assert.equal(token.toLowerCase(), address.toLowerCase());
  assert.ok(expires >= start + 14 * day && expires <= Date.now() + 14 * day);
  assert.equal(
    (await call('invites', 'POST', { role: 'admin', code: address }, primary)).status,
    409,
  );

  const link = new URL('/classroom/', origin);
  link.hash = 'invite=' + encodeURIComponent(token);
  const linkCode = new URLSearchParams(link.hash.slice(1)).get('invite');
  const candidates = ['  ' + address.toUpperCase() + ' ', linkCode];
  const identityProof = await proof(token);
  const claimed = await Promise.all(
    candidates.map((code, i) =>
      call('register', 'POST', {
        username: 'reader-' + i,
        password: account.password,
        role: 'admin',
        token: code,
        ...identityProof,
      }),
    ),
  );
  assert.deepEqual(claimed.map((r) => r.status).sort(), [200, 403]);
  const { user } = await claimed.find((r) => r.status === 200)!.json();
  assert.equal(user.role, 'student');
  assert.equal(user.isPrimary, false);
  assert.equal(
    (await call('register', 'POST', { username: 'repeat', password: account.password, token }))
      .status,
    403,
  );
});

test('custom administrator invitations enforce issuing authority and expire', async () => {
  const { call, bootstrap, db } = fixture();
  const primary = await bootstrap();
  const credentials = { username: 'teacher', password: account.password };
  await call('accounts', 'POST', { ...credentials, role: 'admin' }, primary);
  const teacher = cookieOf(await call('login', 'POST', credentials));
  const invitation = { role: 'admin', code: 'Staff-Code/Group+2' };
  assert.equal((await call('invites', 'POST', invitation, teacher)).status, 403);
  const start = Date.now();
  const issued = await call('invites', 'POST', invitation, primary);
  assert.equal(issued.status, 201);
  const { token, expires } = await issued.json();
  assert.ok(expires >= start + day && expires <= Date.now() + day);
  const newAdmin = { username: 'second-teacher', password: account.password, token };
  assert.equal(token, invitation.code);
  assert.equal(
    (await call('register', 'POST', { ...newAdmin, token: token.toLowerCase() })).status,
    403,
  );
  db.write('UPDATE invites SET expires=?', Date.now() - 1);
  assert.equal((await call('register', 'POST', newAdmin)).status, 403);

  assert.equal((await call('invites', 'POST', invitation, primary)).status, 201);
  const registration = await call('register', 'POST', newAdmin);
  assert.equal(registration.status, 200);
  assert.deepEqual((await registration.json()).user, {
    username: 'second-teacher',
    role: 'admin',
    isPrimary: false,
  });
});

test('blank codes generate a student invitation bound to its intended school email', async () => {
  const { call, bootstrap, proof } = fixture();
  const owner = await bootstrap();
  for (const code of ['too\nlong', 'x'.repeat(257), 123]) {
    assert.equal(
      (await call('invites', 'POST', { role: 'student', code, studentEmail }, owner)).status,
      400,
    );
  }
  const result = await call(
    'invites',
    'POST',
    { role: 'student', code: '   ', studentEmail },
    owner,
  );
  assert.equal(result.status, 201);
  const { token } = await result.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(
    (
      await call('register', 'POST', {
        username: 'student',
        password: account.password,
        token,
        ...(await proof(token)),
      })
    ).status,
    200,
  );
});

test('registration cannot consume a replacement invitation issued under the same code', async () => {
  const { call, db, bootstrap, proof } = fixture();
  const primary = await bootstrap();
  const code = 'group-code';
  assert.equal(
    (await call('invites', 'POST', { role: 'student', code, studentEmail }, primary)).status,
    201,
  );

  // Model a grant being consumed and reissued after the first lookup but before commit.
  const identityProof = await proof(code);
  const atomic = db.atomic;
  db.atomic = (action) => {
    db.atomic = atomic;
    db.write(
      "UPDATE invites SET role='admin', student_email=NULL, issuance=lower(hex(randomblob(32)))",
    );
    return atomic(action);
  };
  const credentials = {
    username: 'reader',
    password: account.password,
    token: code,
    ...identityProof,
  };
  assert.equal((await call('register', 'POST', credentials)).status, 403);
  const fresh = await call('register', 'POST', { ...credentials, username: 'new-tutor' });
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).user.role, 'admin');
});

test('school signup requires a verified proof for the exact invitation and nonce', async () => {
  const { call, bootstrap, challenge, credential } = fixture();
  const owner = await bootstrap();
  const issue = async (studentEmail: string, code: string) => {
    const response = await call('invites', 'POST', { role: 'student', studentEmail, code }, owner);
    assert.equal(response.status, 201);
    return (await response.json()).token as string;
  };
  const token = await issue(studentEmail, 'group-one');
  const otherToken = await issue(classmateEmail, 'group-two');
  const a = await challenge(token);
  const b = await challenge(otherToken);
  assert.equal(a.clientId, testClientId);
  assert.equal(a.email, studentEmail);
  assert.equal(b.email, classmateEmail);
  assert.notEqual(a.nonce, b.nonce);
  const register = (extras: Record<string, unknown>) =>
    call('register', 'POST', {
      username: 'new-learner',
      password: account.password,
      token,
      ...extras,
    });
  for (const attempt of [
    {},
    { email: studentEmail, email_verified: true, hd: 'cpu.edu.hk', googleNonce: a.nonce },
    { googleCredential: 'invented-token', googleNonce: a.nonce },
    { googleCredential: credential(classmateEmail, a.nonce), googleNonce: a.nonce },
    { googleCredential: credential(studentEmail, a.nonce, 'other-client'), googleNonce: a.nonce },
    { googleCredential: credential(studentEmail, b.nonce), googleNonce: a.nonce },
    { googleCredential: credential(studentEmail, b.nonce), googleNonce: b.nonce },
  ]) {
    const response = await register(attempt);
    assert.equal(response.status, 403);
    assert.equal(response.headers.has('Set-Cookie'), false);
  }
  const good = { googleCredential: credential(studentEmail, a.nonce), googleNonce: a.nonce };
  const result = await register(good);
  const student = cookieOf(result);
  assert.equal(
    (await (await call('session', 'GET', undefined, student)).json()).user.role,
    'student',
  );
  assert.equal((await register({ ...good, username: 'replay' })).status, 403);
  // The new grant uses the same invitation text but must require fresh Google proof.
  await issue(studentEmail, token);
  assert.equal((await register({ ...good, username: 'reissue-replay' })).status, 403);
});

test('expired Google nonce and expired classroom invitation both prevent signup', async () => {
  const { bootstrap, call, db, proof } = fixture();
  const owner = await bootstrap();
  const issued = await call('invites', 'POST', { role: 'student', code: studentEmail }, owner);
  assert.equal(issued.status, 201);
  const payload = { username: 'new-student', password: account.password, token: studentEmail };
  const staleNonce = await proof(studentEmail);
  db.write('UPDATE signup_challenges SET expires=?', Date.now() - 1);
  assert.equal((await call('register', 'POST', { ...payload, ...staleNonce })).status, 403);
  const freshNonce = await proof(studentEmail);
  db.write('UPDATE invites SET expires=?', Date.now() - 1);
  assert.equal((await call('register', 'POST', { ...payload, ...freshNonce })).status, 403);
});

test('new student invitations require a matching CPU student address', async () => {
  const { call, bootstrap } = fixture();
  const owner = await bootstrap();
  for (const invite of [
    {},
    { code: 'some-text' },
    { code: 's123456@cpu.edu.hk' },
    { studentEmail: 's12345678@cpu.edu.hk' },
    { studentEmail: 'staff@cpu.edu.hk' },
    { studentEmail: 's1234567@cpu.edu.hk.example.com' },
    { studentEmail: 's1234567+test@cpu.edu.hk' },
    { studentEmail, code: classmateEmail },
    { studentEmail, code: 'somebody@example.com' },
  ]) {
    const response = await call('invites', 'POST', { role: 'student', ...invite }, owner);
    assert.equal(response.status, 400);
  }
});

test('outstanding legacy school-address invitations require proof and unbound student grants fail closed', async () => {
  const { call, db, bootstrap, proof } = fixture();
  await bootstrap();
  for (const code of [studentEmail, 'opaque-legacy-code', 'outsider@example.org']) {
    const digest = createHash('sha256').update(code).digest('hex');
    db.write(
      'INSERT INTO invites (digest,role,expires,issuance) VALUES (?,?,?,?)',
      digest,
      'student',
      Date.now() + 600_000,
      randomUUID(),
    );
    const register = (fields: Record<string, unknown>) =>
      call('register', 'POST', {
        username: 'reader',
        password: account.password,
        token: code,
        ...fields,
      });
    assert.equal((await register({})).status, 403);
    if (code === studentEmail) {
      cookieOf(await register(await proof(code)));
    } else {
      assert.equal((await call('signup/google/challenge', 'POST', { token: code })).status, 403);
      assert.equal(
        (await register({ googleNonce: 'fake', googleCredential: 'fake', studentEmail })).status,
        403,
      );
    }
  }
});

test('school signup fails closed until Google is configured; setup and non-school admin invitations work', async () => {
  const { call, db, bootstrap } = fixture(adminToken, undefined, undefined, '');
  const owner = await bootstrap();
  const digest = createHash('sha256').update(studentEmail).digest('hex');
  db.write(
    'INSERT INTO invites (digest,role,expires,issuance) VALUES (?,?,?,?)',
    digest,
    'student',
    Date.now() + 600_000,
    randomUUID(),
  );
  assert.equal(
    (await call('signup/google/challenge', 'POST', { token: studentEmail })).status,
    503,
  );
  const noClient = await call('register', 'POST', {
    username: 'visitor',
    password: account.password,
    token: studentEmail,
    googleCredential: 'fake',
    googleNonce: 'fake',
  });
  assert.equal(noClient.status, 503);
  assert.equal(noClient.headers.has('set-cookie'), false);
  const adminGrant = await call('invites', 'POST', { role: 'admin', code: 'staff-invite' }, owner);
  const { token } = await adminGrant.json();
  const screen = await call('signup/google/challenge', 'POST', { token });
  assert.equal((await screen.json()).required, false);
  const register = await call('register', 'POST', {
    username: 'ordinary',
    password: account.password,
    token,
  });
  assert.equal((await register.json()).user.role, 'admin');
});

test('only the primary admin may change the Google client; switching it invalidates outstanding nonces', async () => {
  const { call, bootstrap, proof, credential, challenge } = fixture();
  const owner = await bootstrap();
  assert.equal(
    (
      await call(
        'accounts',
        'POST',
        { username: 'other', password: account.password, role: 'admin' },
        owner,
      )
    ).status,
    201,
  );
  const ordinary = cookieOf(
    await call('login', 'POST', { username: 'other', password: account.password }),
  );
  const path = 'settings/google';
  const replacement = '67890-school.apps.googleusercontent.com';
  assert.equal((await call(path, 'PATCH', { clientId: replacement })).status, 401);
  assert.equal((await call(path, 'PATCH', { clientId: replacement }, ordinary)).status, 403);
  assert.equal(
    (await call(path, 'PATCH', { clientId: 'https://not-a-client.example' }, owner)).status,
    400,
  );
  assert.equal(
    (await call('invites', 'POST', { role: 'student', code: studentEmail }, ordinary)).status,
    201,
  );
  const previous = await proof(studentEmail);
  assert.equal((await call(path, 'PATCH', { clientId: replacement }, owner)).status, 200);
  const register = (fields: Record<string, unknown>) =>
    call('register', 'POST', {
      username: 'student',
      password: account.password,
      token: studentEmail,
      ...fields,
    });
  assert.equal((await register(previous)).status, 403);
  const newChallenge = await challenge(studentEmail);
  assert.equal(newChallenge.clientId, replacement);
  cookieOf(
    await register({
      googleNonce: newChallenge.nonce,
      googleCredential: credential(studentEmail, newChallenge.nonce, replacement),
    }),
  );
});

test('seven-digit CPU numbers claim custom and generated student invitations without exposing their codes', async () => {
  const { call, bootstrap, credential } = fixture();
  const owner = await bootstrap();
  for (const [studentNumber, code] of [
    ['2020123', 'private-team-invite'],
    ['0202123', ''],
  ]) {
    const email = 's' + studentNumber + '@cpu.edu.hk';
    const issued = await call(
      'invites',
      'POST',
      { role: 'student', studentEmail: email, code },
      owner,
    );
    assert.equal(issued.status, 201);
    const { token } = await issued.json();

    const response = await call('signup/google/challenge', 'POST', { studentNumber });
    assert.equal(response.status, 200);
    const challenge = await response.json();
    assert.equal(challenge.required, true);
    assert.equal(challenge.email, email);
    assert.equal(challenge.clientId, testClientId);
    assert.ok(challenge.nonce.length >= 32);
    assert.ok(!JSON.stringify(challenge).includes(token));
    assert.ok(
      !JSON.stringify(challenge).includes(createHash('sha256').update(token).digest('hex')),
    );

    const signup = {
      username: 'member-' + studentNumber,
      password: account.password,
      studentNumber,
      googleNonce: challenge.nonce,
      googleCredential: credential(email, challenge.nonce),
    };
    const registered = await call('register', 'POST', signup);
    cookieOf(registered);
    assert.deepEqual((await registered.json()).user, {
      username: signup.username,
      role: 'student',
      isPrimary: false,
    });
    assert.equal((await call('register', 'POST', { ...signup, username: 'replay' })).status, 403);
    assert.equal((await call('signup/google/challenge', 'POST', { token })).status, 403);
  }
});

test('number signup is restricted to the invited student, a valid Google proof, and the original issuance', async () => {
  const { call, bootstrap, credential, db } = fixture();
  const owner = await bootstrap();
  const number = '2020123';
  const email = 's' + number + '@cpu.edu.hk';
  const otherNumber = '2020456';
  const otherEmail = 's' + otherNumber + '@cpu.edu.hk';
  const lookup = (body: unknown) => call('signup/google/challenge', 'POST', body);
  const accountGrant = { role: 'student', code: 'team-code', studentEmail: email };
  assert.equal((await lookup({ studentNumber: number })).status, 403);
  assert.equal((await call('invites', 'POST', accountGrant, owner)).status, 201);
  assert.equal(
    (await call('invites', 'POST', { role: 'student', studentEmail: otherEmail }, owner)).status,
    201,
  );
  const { nonce } = await (await lookup({ studentNumber: number })).json();
  const register = (extra: Record<string, unknown>) =>
    call('register', 'POST', {
      username: 'someone',
      password: account.password,
      studentNumber: number,
      ...extra,
    });
  for (const fields of [
    {},
    { googleNonce: nonce },
    { googleNonce: nonce, googleCredential: credential(otherEmail, nonce) },
    {
      studentNumber: otherNumber,
      googleNonce: nonce,
      googleCredential: credential(otherEmail, nonce),
    },
  ]) {
    const rejected = await register(fields);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.has('Set-Cookie'), false);
  }

  // Replace this student's invitation. A proof from the earlier issue must still fail.
  db.write('DELETE FROM invites WHERE student_email=?', email);
  assert.equal((await call('invites', 'POST', accountGrant, owner)).status, 201);
  assert.equal(
    (await register({ googleNonce: nonce, googleCredential: credential(email, nonce) })).status,
    403,
  );
  const replacement = await (await lookup({ studentNumber: number })).json();
  assert.equal(
    (
      await register({
        googleNonce: replacement.nonce,
        googleCredential: credential(email, replacement.nonce),
      })
    ).status,
    200,
  );
});

test('number lookup recognizes legacy school-address student grants and excludes administrator invitations', async () => {
  const { call, bootstrap, credential, db } = fixture();
  const owner = await bootstrap();
  const studentNumber = '2020123';
  const email = 's' + studentNumber + '@cpu.edu.hk';
  const adminInvite = await call(
    'invites',
    'POST',
    { role: 'admin', code: 'private-mentor', studentEmail: email },
    owner,
  );
  assert.equal(adminInvite.status, 201);
  const lookup = (body: unknown) => call('signup/google/challenge', 'POST', body);
  assert.equal((await lookup({ studentNumber })).status, 403);
  db.write(
    'INSERT INTO invites (digest,role,expires,issuance) VALUES (?,?,?,?)',
    createHash('sha256').update(email).digest('hex'),
    'student',
    Date.now() + 600000,
    randomUUID(),
  );
  for (const invalid of ['202123', '20200123', email, '２０２０１２３', 2020123]) {
    assert.equal((await lookup({ studentNumber: invalid })).status, 400);
  }
  assert.equal((await lookup({ studentNumber, token: 'private-mentor' })).status, 400);
  const grant = await (await lookup({ studentNumber })).json();
  const fields = {
    username: 'legacy-student',
    password: account.password,
    studentNumber,
    googleNonce: grant.nonce,
    googleCredential: credential(email, grant.nonce),
  };
  assert.equal(
    (await call('register', 'POST', { ...fields, token: 'private-mentor' })).status,
    400,
  );
  const adminProof = await (await lookup({ token: 'private-mentor' })).json();
  const adminThroughNumber = await call('register', 'POST', {
    ...fields,
    googleNonce: adminProof.nonce,
    googleCredential: credential(email, adminProof.nonce),
  });
  assert.equal(adminThroughNumber.status, 403);
  const result = await call('register', 'POST', fields);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).user.role, 'student');
  assert.equal((await lookup({ token: 'private-mentor' })).status, 200);
});

test('quick student authorization is admin-only, same-origin, and requires seven digits', async () => {
  const { call, bootstrap } = fixture();
  const owner = await bootstrap();
  const student = { username: 'reader', password: account.password };
  await call('accounts', 'POST', { ...student, role: 'student' }, owner);
  const studentCookie = cookieOf(await call('login', 'POST', student));
  const path = 'student-registrations';
  const input = { studentNumber: '0202123' };
  assert.equal((await call(path, 'POST', input)).status, 401);
  assert.equal((await call(path, 'POST', input, studentCookie)).status, 403);
  assert.equal(
    (await call(path, 'POST', input, owner, { Origin: 'https://outside.example' })).status,
    403,
  );
  for (const studentNumber of [
    '020212',
    '02021234',
    's0202123@cpu.edu.hk',
    '０２０２１２３',
    202123,
  ]) {
    assert.equal((await call(path, 'POST', { studentNumber }, owner)).status, 400);
  }
  assert.equal((await call(path, 'POST', { ...input, role: 'admin' }, owner)).status, 400);
  assert.equal((await call('signup/google/challenge', 'POST', input)).status, 403);
});

test('both administrators can authorize a number once; registration still verifies its exact school account', async () => {
  const { call, bootstrap, credential } = fixture();
  const owner = await bootstrap();
  const teacher = { username: 'teacher', password: account.password };
  await call('accounts', 'POST', { ...teacher, role: 'admin' }, owner);
  const ordinary = cookieOf(await call('login', 'POST', teacher));
  const studentNumber = '0202123';
  const email = 's0202123@cpu.edu.hk';
  const input = { studentNumber };
  const start = Date.now();
  const responses = await Promise.all(
    [owner, ordinary].map((cookie) => call('student-registrations', 'POST', input, cookie)),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  const first = await responses.find((r) => r.status === 201)!.json();
  const duplicate = await responses.find((r) => r.status === 200)!.json();
  assert.deepEqual(first, { studentNumber, email, expires: first.expires, created: true });
  assert.deepEqual(duplicate, { ...first, created: false });
  assert.ok(first.expires >= start + 14 * day && first.expires <= Date.now() + 14 * day);
  const lookup = () => call('signup/google/challenge', 'POST', input);
  const challenge = await lookup();
  assert.equal(challenge.status, 200);
  const { nonce, email: invitedEmail } = await challenge.json();
  assert.equal(invitedEmail, email);
  const fields = {
    username: 'new-member',
    password: account.password,
    studentNumber,
    googleNonce: nonce,
  };
  assert.equal((await call('register', 'POST', fields)).status, 403);
  assert.equal(
    (
      await call('register', 'POST', {
        ...fields,
        googleCredential: credential(classmateEmail, nonce),
      })
    ).status,
    403,
  );
  const registered = await call('register', 'POST', {
    ...fields,
    googleCredential: credential(email, nonce),
  });
  cookieOf(registered);
  assert.deepEqual((await registered.json()).user, {
    username: 'new-member',
    role: 'student',
    isPrimary: false,
  });
  assert.equal((await lookup()).status, 403);
});

test('quick authorization reuses an existing student invitation, replaces expired access, and leaves administrator grants intact', async () => {
  const { bootstrap, call, db, challenge } = fixture();
  const owner = await bootstrap();
  const email = 's2020123@cpu.edu.hk';
  const input = { studentNumber: '2020123' };
  const adminToken = 'mentor-only-token';
  await call('invites', 'POST', { role: 'admin', code: adminToken, studentEmail: email }, owner);
  await call(
    'invites',
    'POST',
    { role: 'student', code: 'a-custom-invitation', studentEmail: email },
    owner,
  );
  const expires = Date.now() + 60000;
  db.write('UPDATE invites SET expires=? WHERE role=?', expires, 'student');
  const result = await call('student-registrations', 'POST', input, owner);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ...input, email, expires, created: false });
  assert.equal((await challenge('a-custom-invitation')).email, email);
  db.write('UPDATE invites SET expires=? WHERE role=?', Date.now() - 1, 'student');
  assert.equal((await call('signup/google/challenge', 'POST', input)).status, 403);
  const renewed = await call('student-registrations', 'POST', input, owner);
  assert.equal(renewed.status, 201);
  assert.equal((await renewed.json()).created, true);
  assert.equal((await call('signup/google/challenge', 'POST', input)).status, 200);
  assert.equal((await challenge(adminToken)).email, email);
});

test('upgrading preserves recorded deadlines and leaves consumed grants spent across restarts', async () => {
  const { db, call, bootstrap, proof } = fixture();
  const owner = await bootstrap();
  const { token } = await (
    await call('invites', 'POST', { role: 'student', studentEmail }, owner)
  ).json();
  cookieOf(
    await call('register', 'POST', {
      username: 'already-registered',
      password: account.password,
      token,
      ...(await proof(token)),
    }),
  );

  // Older classrooms may have never run the previous 14-day migration.
  db.write('DELETE FROM classroom_settings WHERE name=?', 'studentRegistration14Days');
  const oldExpiry = Date.now() + 12 * 60 * 60 * 1000;
  const expired = Date.now() - 60_000;
  for (const [digest, role, expires] of [
    ['active-student', 'student', oldExpiry],
    ['expired-student', 'student', expired],
    ['active-admin', 'admin', oldExpiry],
  ] as const) {
    db.write('INSERT INTO invites (digest,role,expires) VALUES (?,?,?)', digest, role, expires);
  }

  const expected = {
    'active-student': oldExpiry,
    'expired-student': expired,
    'active-admin': oldExpiry,
  };
  const expiries = () =>
    Object.fromEntries(
      db
        .all<{ digest: string; expires: number }>('SELECT digest,expires FROM invites')
        .map((row) => [row.digest, row.expires]),
    );
  initialize(db);
  assert.deepEqual(expiries(), expected);
  initialize(db);
  assert.deepEqual(expiries(), expected);
  assert.equal((await call('signup/google/challenge', 'POST', { token })).status, 403);
});

test('both ways of authorizing students enforce the selected validity period', async (t) => {
  const { call, bootstrap } = fixture();
  const owner = await bootstrap();
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const path = 'student-registrations';
  const input = { studentNumber: '1234567' };
  const custom = { role: 'student', studentEmail: classmateEmail };
  for (const validityDays of [0, -1, 1.5, 3651, '14', false, {}]) {
    assert.equal((await call(path, 'POST', { ...input, validityDays }, owner)).status, 400);
    assert.equal((await call('invites', 'POST', { ...custom, validityDays }, owner)).status, 400);
  }
  assert.equal(
    (await call('invites', 'POST', { role: 'admin', validityDays: null }, owner)).status,
    400,
  );
  const quick = await call(path, 'POST', { ...input, validityDays: 1 }, owner);
  assert.equal(quick.status, 201);
  assert.equal((await quick.json()).expires, now + day);
  const retry = await call(path, 'POST', { ...input, validityDays: null }, owner);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    ...input,
    email: studentEmail,
    expires: now + day,
    created: false,
  });
  const invitation = await call('invites', 'POST', { ...custom, validityDays: 3650 }, owner);
  assert.equal(invitation.status, 201);
  const { token, expires } = await invitation.json();
  assert.equal(expires, now + 3650 * day);

  const lookup = (payload: object) => call('signup/google/challenge', 'POST', payload);
  t.mock.timers.tick(day - 1);
  assert.equal((await lookup(input)).status, 200);
  t.mock.timers.tick(1);
  assert.equal((await lookup(input)).status, 403);
  assert.equal((await lookup({ token })).status, 200);
  t.mock.timers.tick(3649 * day);
  assert.equal((await lookup({ token })).status, 403);
});

test('permanent student authorizations survive until used and require matching Google verification', async (t) => {
  const { call, bootstrap, credential, db } = fixture();
  const owner = await bootstrap();
  const input = { studentNumber: '1234567' };
  const grant = await call(
    'student-registrations',
    'POST',
    { ...input, validityDays: null },
    owner,
  );
  assert.equal(grant.status, 201);
  assert.equal((await grant.json()).expires, null);
  const duplicate = await call(
    'student-registrations',
    'POST',
    { ...input, validityDays: 1 },
    owner,
  );
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), {
    ...input,
    email: studentEmail,
    expires: null,
    created: false,
  });
  initialize(db);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5000 * day });
  const lookup = await call('signup/google/challenge', 'POST', input);
  assert.equal(lookup.status, 200);
  const { nonce } = await lookup.json();
  const payload = {
    ...input,
    username: 'future-student',
    password: account.password,
    googleNonce: nonce,
  };
  assert.equal((await call('register', 'POST', payload)).status, 403);
  assert.equal(
    (
      await call('register', 'POST', {
        ...payload,
        googleCredential: credential(classmateEmail, nonce),
      })
    ).status,
    403,
  );
  cookieOf(
    await call('register', 'POST', {
      ...payload,
      googleCredential: credential(studentEmail, nonce),
    }),
  );
  assert.equal((await call('signup/google/challenge', 'POST', input)).status, 403);
});

test('cancelling from an admin list protects newer grants and invalidates outstanding student proofs', async () => {
  const { call, bootstrap, proof } = fixture();
  const owner = await bootstrap();
  const teacher = { username: 'teacher', password: account.password };
  assert.equal((await call('accounts', 'POST', { ...teacher, role: 'admin' }, owner)).status, 201);
  const ordinary = cookieOf(await call('login', 'POST', teacher));
  const path = 'student-registrations';
  const numberPath = path + '/1234567';
  const list = async () => {
    const response = await call(path, 'GET', undefined, ordinary);
    assert.equal(response.status, 200);
    return (await response.json()).registrations;
  };
  const remove = (version: string) => call(numberPath, 'DELETE', { version }, ordinary);
  const issue = (code: string, validityDays: number | null) =>
    call('invites', 'POST', { role: 'student', code, studentEmail, validityDays }, ordinary);
  assert.equal(
    (await call('invites', 'POST', { role: 'admin', studentEmail, code: 'admin-link' }, owner))
      .status,
    201,
  );
  assert.deepEqual(await list(), []);
  const adminProof = await proof('admin-link');
  assert.equal((await issue('finite-code', 20)).status, 201);
  const [finite] = await list();
  const finiteProof = await proof('finite-code');
  assert.equal((await issue('permanent-code', null)).status, 201);
  const [combined] = await list();
  assert.deepEqual(combined, {
    studentNumber: '1234567',
    email: studentEmail,
    expires: null,
    version: combined.version,
  });
  assert.notEqual(combined.version, finite.version);
  assert.equal((await remove(finite.version)).status, 409);
  const permanentProof = await proof('permanent-code');
  const other = { studentNumber: '7654321' };
  assert.equal((await call(path, 'POST', other, owner)).status, 201);
  assert.equal((await remove(combined.version)).status, 200);
  assert.equal((await remove(combined.version)).status, 404);
  assert.deepEqual(
    (await list()).map((row: { studentNumber: string }) => row.studentNumber),
    [other.studentNumber],
  );
  const lookup = (payload: object) => call('signup/google/challenge', 'POST', payload);
  for (const payload of [
    { studentNumber: '1234567' },
    { token: 'finite-code' },
    { token: 'permanent-code' },
  ]) {
    assert.equal((await lookup(payload)).status, 403);
  }
  assert.equal((await lookup(other)).status, 200);
  assert.equal((await issue('permanent-code', null)).status, 201);
  assert.equal((await remove(combined.version)).status, 409);
  const register = (fields: object) =>
    call('register', 'POST', { username: 'new-member', password: account.password, ...fields });
  assert.equal((await register({ studentNumber: '1234567', ...finiteProof })).status, 403);
  assert.equal((await register({ token: 'permanent-code', ...permanentProof })).status, 403);
  cookieOf(await register({ token: 'permanent-code', ...(await proof('permanent-code')) }));
  const adminUser = await register({ token: 'admin-link', ...adminProof, username: 'new-teacher' });
  assert.equal(adminUser.status, 200);
  assert.equal((await adminUser.json()).user.role, 'admin');
});

test('lists, legacy number lookup and cancellation require an administrator and protect against cross-origin writes', async () => {
  const oldExpiry = Date.now() + 3 * day;
  const digest = createHash('sha256').update(studentEmail).digest('hex');
  const { call, bootstrap } = fixture(adminToken, (db) => {
    // Model the deployed schema and an active address-as-code grant with three days left.
    db.write(
      "CREATE TABLE invites (digest TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL, issuance TEXT NOT NULL DEFAULT '', student_email TEXT)",
    );
    db.write(
      'INSERT INTO invites (digest,role,expires) VALUES (?,?,?)',
      digest,
      'student',
      oldExpiry,
    );
    db.write('CREATE TABLE classroom_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.write("INSERT INTO classroom_settings VALUES ('studentRegistration14Days','done')");
  });
  const owner = await bootstrap();
  const student = { username: 'reader', password: account.password };
  assert.equal(
    (await call('accounts', 'POST', { ...student, role: 'student' }, owner)).status,
    201,
  );
  const studentCookie = cookieOf(await call('login', 'POST', student));
  const listPath = 'student-registrations';
  const numberPath = listPath + '/1234567';
  for (const [cookie, status] of [
    ['', 401],
    [studentCookie, 403],
  ] as const) {
    assert.equal((await call(listPath, 'GET', undefined, cookie)).status, status);
    assert.equal((await call(numberPath, 'GET', undefined, cookie)).status, status);
    assert.equal((await call(numberPath, 'DELETE', {}, cookie)).status, status);
  }
  const result = await call(numberPath, 'GET', undefined, owner);
  assert.equal(result.status, 200);
  const { registration } = await result.json();
  assert.equal(registration.expires, oldExpiry);
  assert.equal(registration.email, studentEmail);
  const version = { version: registration.version };
  assert.equal((await call(numberPath, 'DELETE', {}, owner)).status, 400);
  assert.equal(
    (await call(numberPath, 'DELETE', version, owner, { Origin: 'https://outside.example' }))
      .status,
    403,
  );
  assert.equal((await call(numberPath, 'DELETE', version, owner)).status, 200);
  assert.equal((await call(numberPath, 'GET', undefined, owner)).status, 404);
  assert.equal(
    (await call('signup/google/challenge', 'POST', { token: studentEmail })).status,
    403,
  );
});

const application = {
  studentNumber: '0123456',
  studentName: '陳同學',
  yearOfStudy: 4,
  phyTeamMember: true,
};

test('only an unapproved CPU number in the signup lookup routes to the access form', async () => {
  const { bootstrap, call } = fixture(adminToken, undefined, undefined, '');
  const owner = await bootstrap();
  const lookup = (fields: object) => call('signup/google/challenge', 'POST', fields);
  const number = { studentNumber: application.studentNumber };
  const unavailable = await lookup(number);
  assert.equal(unavailable.status, 403);
  assert.equal((await unavailable.json()).code, 'student_access_required');
  for (const [input, status] of [
    [{ token: 'unknown-link' }, 403],
    [{ studentNumber: '123' }, 400],
    [{ ...number, token: 'unknown-link' }, 400],
  ] as const) {
    const response = await lookup(input);
    assert.equal(response.status, status);
    assert.notEqual((await response.json()).code, 'student_access_required');
  }
  assert.equal((await call('access-requests/challenge', 'POST', number)).status, 503);
  assert.equal((await call('student-registrations', 'POST', number, owner)).status, 201);
  const configurationError = await lookup(number);
  assert.equal(configurationError.status, 503);
  assert.notEqual((await configurationError.json()).code, 'student_access_required');
});

test('a class sharing one IP can look up unapproved numbers and still request access or sign in', async () => {
  const { bootstrap, call, accessProof } = fixture();
  await bootstrap();
  for (let i = 0; i < 25; i++) {
    const response = await call('signup/google/challenge', 'POST', {
      studentNumber: String(2020100 + i),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'student_access_required');
  }
  const proof = await accessProof(application.studentNumber);
  assert.equal((await call('access-requests', 'POST', { ...application, ...proof })).status, 201);
  for (let i = 25; i < 120; i++) {
    const response = await call('signup/google/challenge', 'POST', {
      studentNumber: String(2020100 + i),
    });
    assert.equal(response.status, 403);
  }
  const limited = await call('signup/google/challenge', 'POST', { studentNumber: '2020999' });
  assert.equal(limited.status, 429);
  cookieOf(await call('login', 'POST', account));
});

test('access requests validate student details, preserve one pending submission, and confer no access', async () => {
  const { bootstrap, call, accessProof } = fixture();
  const owner = await bootstrap();
  const proof = await accessProof(application.studentNumber);
  const submit = (fields: object) =>
    call('access-requests', 'POST', { ...application, ...proof, ...fields });
  for (const fields of [
    { studentName: '   ' },
    { studentName: 'x'.repeat(101) },
    { yearOfStudy: 0 },
    { yearOfStudy: 7 },
    { yearOfStudy: 1.1 },
    { yearOfStudy: '1' },
    { phyTeamMember: 'no' },
    { phyTeamMember: undefined },
    { phyTeamMember: false },
    { phyTeamMember: false, justification: '   ' },
    { phyTeamMember: false, justification: 'x'.repeat(1001) },
  ]) {
    assert.equal((await submit(fields)).status, 400, JSON.stringify(fields));
  }
  const fields = {
    studentName: '  ' + application.studentName + '  ',
    phyTeamMember: false,
    justification: '  I would like to train for the Olympiad.  ',
  };
  const responses = await Promise.all([submit(fields), submit(fields)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  for (const response of responses) {
    assert.equal(response.headers.has('set-cookie'), false);
    assert.deepEqual(await response.json(), { status: 'pending' });
  }
  const repeated = await submit({
    yearOfStudy: 6,
    ...(await accessProof(application.studentNumber)),
  });
  assert.equal(repeated.status, 200);

  const list = await call('access-requests', 'GET', undefined, owner);
  assert.match(list.headers.get('Cache-Control') ?? '', /no-store/);
  const { requests } = await list.json();
  assert.equal(requests.length, 1);
  const row = requests[0];
  assert.ok(typeof row.id === 'string' && row.id.length > 0);
  assert.ok(Number.isSafeInteger(row.createdAt) && row.createdAt > 0);
  assert.deepEqual(row, {
    ...application,
    id: row.id,
    createdAt: row.createdAt,
    phyTeamMember: false,
    justification: fields.justification.trim(),
  });
  assert.equal(
    (await call('signup/google/challenge', 'POST', { studentNumber: application.studentNumber }))
      .status,
    403,
  );
  const accounts = await call('accounts', 'GET', undefined, owner);
  assert.equal((await accounts.json()).accounts.length, 1);
});

test('only fresh school Google proofs for the applicant and the access-request purpose are accepted', async (t) => {
  const { bootstrap, call, accessProof, proof, credential } = fixture();
  const owner = await bootstrap();
  const number = application.studentNumber;
  const email = 's' + number + '@cpu.edu.hk';
  const issued = await call('invites', 'POST', { role: 'admin', studentEmail: email }, owner);
  const { token } = await issued.json();
  const invitationProof = await proof(token, email);
  const requestProof = await accessProof(number);
  const submit = (fields: object) => call('access-requests', 'POST', { ...application, ...fields });
  for (const fields of [
    {},
    invitationProof,
    { ...requestProof, studentNumber: '7654321' },
    { ...requestProof, googleCredential: credential(classmateEmail, requestProof.googleNonce) },
  ]) {
    assert.equal((await submit(fields)).status, 403);
  }
  const signup = await call('register', 'POST', {
    username: 'visitor',
    password: account.password,
    token,
    ...requestProof,
  });
  assert.equal(signup.status, 403);
  assert.equal(signup.headers.has('set-cookie'), false);

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal((await submit(requestProof)).status, 403);
  const beforeChange = await accessProof(number);
  const newClient = '45678-school.apps.googleusercontent.com';
  assert.equal(
    (await call('settings/google', 'PATCH', { clientId: newClient }, owner)).status,
    200,
  );
  assert.equal((await submit(beforeChange)).status, 403);
  const list = await call('access-requests', 'GET', undefined, owner);
  assert.deepEqual((await list.json()).requests, []);
  assert.equal((await submit(await accessProof(number))).status, 201);
});

test('administrators review student requests once and approval requires a new verified student signup', async (t) => {
  const { bootstrap, call, accessProof, credential } = fixture();
  const owner = await bootstrap();
  async function createUser(role: 'student' | 'admin') {
    const fields = { username: role + '-reviewer', password: account.password };
    assert.equal((await call('accounts', 'POST', { ...fields, role }, owner)).status, 201);
    return cookieOf(await call('login', 'POST', fields));
  }
  const admin = await createUser('admin');
  const student = await createUser('student');
  const foreign = { Origin: 'https://other.example' };
  const number = { studentNumber: application.studentNumber };
  assert.equal((await call('access-requests/challenge', 'POST', number, '', foreign)).status, 403);
  const submission = {
    ...application,
    justification: 'A discarded explanation from before membership was changed to Yes.',
    ...(await accessProof(number.studentNumber)),
  };
  assert.equal((await call('access-requests', 'POST', submission, '', foreign)).status, 403);
  assert.equal((await call('access-requests', 'POST', submission)).status, 201);
  const rows = await call('access-requests', 'GET', undefined, admin);
  assert.equal(rows.status, 200);
  const [row] = (await rows.json()).requests;
  assert.equal(row.phyTeamMember, true);
  assert.equal(row.justification, '');
  const path = 'access-requests/' + row.id + '/review';
  const decision = { decision: 'approve', validityDays: 7 };
  for (const [cookie, status] of [
    ['', 401],
    [student, 403],
  ] as const) {
    const list = await call('access-requests', 'GET', undefined, cookie);
    assert.equal(list.status, status);
    assert.ok(!(await list.text()).includes(application.studentName));
    assert.equal((await call(path, 'POST', decision, cookie)).status, status);
  }
  assert.equal((await call(path, 'POST', decision, admin, foreign)).status, 403);
  assert.equal((await call(path, 'POST', { ...decision, validityDays: 0 }, admin)).status, 400);
  assert.equal((await call(path, 'POST', { decision: 'grant-admin' }, admin)).status, 400);

  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const reviewed = await Promise.all(
    [admin, owner].map((cookie) => call(path, 'POST', decision, cookie)),
  );
  assert.deepEqual(reviewed.map((r) => r.status).sort(), [200, 404]);
  assert.deepEqual(await reviewed.find((r) => r.status === 200)!.json(), { status: 'approved' });
  const grants = await (await call('student-registrations', 'GET', undefined, owner)).json();
  assert.equal(grants.registrations.length, 1);
  assert.equal(grants.registrations[0].expires, now + 7 * day);
  assert.deepEqual(
    (await (await call('access-requests', 'GET', undefined, owner)).json()).requests,
    [],
  );
  assert.equal((await call('access-requests', 'POST', submission)).status, 409);
  const alreadyAllowed = await call('access-requests/challenge', 'POST', number);
  assert.equal(alreadyAllowed.status, 409);
  assert.equal((await alreadyAllowed.json()).code, 'student_access_granted');

  const lookup = await call('signup/google/challenge', 'POST', number);
  assert.equal(lookup.status, 200);
  const { nonce, email } = await lookup.json();
  const signup = { ...number, username: 'approved-student', password: account.password };
  assert.equal(
    (
      await call('register', 'POST', {
        ...signup,
        googleNonce: submission.googleNonce,
        googleCredential: submission.googleCredential,
      })
    ).status,
    403,
  );
  const session = await call('register', 'POST', {
    ...signup,
    googleNonce: nonce,
    googleCredential: credential(email, nonce),
  });
  cookieOf(session);
  assert.equal((await session.json()).user.role, 'student');
  assert.equal((await call('signup/google/challenge', 'POST', number)).status, 403);
});

test('declines revoke outstanding requests and independent authorizations clear obsolete reviews', async () => {
  const { bootstrap, call, accessProof } = fixture();
  const owner = await bootstrap();
  const number = { studentNumber: application.studentNumber };
  const staleProof = await accessProof(number.studentNumber);
  const post = (fields: object) => call('access-requests', 'POST', { ...application, ...fields });
  assert.equal((await post(await accessProof(number.studentNumber))).status, 201);
  const list = async () =>
    (await (await call('access-requests', 'GET', undefined, owner)).json()).requests;
  const decline = (id: string) =>
    call('access-requests/' + id + '/review', 'POST', { decision: 'decline' }, owner);
  const [first] = await list();
  const result = await decline(first.id);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: 'declined' });
  assert.deepEqual(await list(), []);
  assert.equal((await call('signup/google/challenge', 'POST', number)).status, 403);
  assert.equal((await post(staleProof)).status, 403);

  for (const grantType of ['quick', 'custom']) {
    const proof = await accessProof(number.studentNumber);
    assert.equal((await post(proof)).status, 201);
    const [current] = await list();
    assert.notEqual(current.id, first.id);
    assert.equal((await decline(first.id)).status, 404);
    const allowed =
      grantType === 'quick'
        ? await call('student-registrations', 'POST', { ...number, validityDays: null }, owner)
        : await call(
            'invites',
            'POST',
            { role: 'student', studentEmail: 's' + number.studentNumber + '@cpu.edu.hk' },
            owner,
          );
    assert.equal(allowed.status, 201);
    assert.deepEqual(await list(), []);
    assert.equal((await decline(current.id)).status, 404);
    const grantPath = 'student-registrations/' + number.studentNumber;
    const { registration } = await (await call(grantPath, 'GET', undefined, owner)).json();
    assert.equal(
      (await call(grantPath, 'DELETE', { version: registration.version }, owner)).status,
      200,
    );
    assert.equal((await post(proof)).status, 403);
  }
});

test('student-number recovery delivers only to the verified school address and resets once', async () => {
  const messages: { email: string; token: string; username: string }[] = [];
  const { db, call, bootstrap, credential } = fixture(
    adminToken,
    undefined,
    undefined,
    testClientId,
    async (message) => {
      messages.push(message);
    },
  );
  const admin = await bootstrap();
  const studentNumber = '1234567';
  await call('student-registrations', 'POST', { studentNumber }, admin);
  const { nonce } = await (await call('signup/google/challenge', 'POST', { studentNumber })).json();
  const login = { username: 'reset-student', password: account.password };
  const session = cookieOf(
    await call('register', 'POST', {
      ...login,
      studentNumber,
      googleNonce: nonce,
      googleCredential: credential(studentEmail, nonce),
    }),
  );
  const request = () =>
    call('password-recovery', 'POST', { username: login.username, email: classmateEmail });
  assert.equal((await request()).status, 202);
  assert.equal((await request()).status, 202);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].email, studentEmail);
  assert.equal(
    db.all<{ digest: string }>('SELECT digest FROM password_resets')[0].digest,
    createHash('sha256').update(messages[0].token).digest('hex'),
  );
  const redeem = () =>
    call('password-recovery/complete', 'POST', {
      token: messages[0].token,
      newPassword: 'different student password',
    });
  assert.deepEqual(
    (await Promise.all([redeem(), redeem()])).map((r) => r.status).sort(),
    [200, 403],
  );
  assert.equal((await (await call('session', 'GET', undefined, session)).json()).user, null);
  assert.equal((await call('login', 'POST', login)).status, 401);
  assert.equal(
    (await call('login', 'POST', { ...login, password: 'different student password' })).status,
    200,
  );
  await request();
  db.write('UPDATE password_resets SET created=0');
  assert.equal(
    (
      await call('password-recovery/complete', 'POST', {
        token: messages[1].token,
        newPassword: account.password,
      })
    ).status,
    403,
  );
});

test('admins can see stored CPU addresses only for students in the account directory', async () => {
  const { db, call, bootstrap } = fixture();
  const primary = await bootstrap();
  const teacher = { username: 'teacher', password: account.password };
  for (const [username, role, email] of [
    [teacher.username, 'admin', classmateEmail],
    ['linked', 'student', studentEmail],
    ['external', 'student', 'fixture@example.com'],
    ['manual', 'student', null],
  ] as const) {
    await call('accounts', 'POST', { username, password: account.password, role }, primary);
    db.write('UPDATE users SET recovery_email=? WHERE username=?', email, username);
  }
  const ordinary = cookieOf(await call('login', 'POST', teacher));
  for (const actor of [primary, ordinary]) {
    const response = await call('accounts', 'GET', undefined, actor);
    assert.equal(response.status, 200);
    const { accounts } = await response.json();
    for (const row of accounts) {
      assert.equal(row.cpuEmail, row.username === 'linked' ? studentEmail : undefined);
      assert.equal(row.recovery_email, undefined);
    }
    assert.ok(accounts.some((row: { cpuEmail?: string }) => row.cpuEmail === studentEmail));
  }
  const student = cookieOf(await call('login', 'POST', { username: 'linked', password: account.password }));
  assert.equal((await call('accounts', 'GET', undefined, student)).status, 403);
  assert.equal((await call('accounts')).status, 401);
});

test('manual recovery requests flag existing accounts without exposing their existence', async () => {
  const { call, bootstrap } = fixture();
  const admin = await bootstrap();
  await call(
    'accounts',
    'POST',
    { username: 'manual-user', password: account.password, role: 'student' },
    admin,
  );
  const request = async (username: string) =>
    (await call('password-recovery', 'POST', { username })).json();
  assert.deepEqual(await request('manual-user'), await request('unknown-name'));
  const { accounts } = await (await call('accounts', 'GET', undefined, admin)).json();
  const student = accounts.find((a: { username: string }) => a.username === 'manual-user');
  assert.equal(student.resetRequested, true);
  const response = await call(
    'accounts/manual-user/password',
    'POST',
    { version: student.version, newPassword: 'reset by teacher' },
    admin,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).account.resetRequested, undefined);
});

test('student activity belongs to the session, respects releases, and is private to admins', async () => {
  const { call, bootstrap, db } = fixture();
  const owner = await bootstrap();
  async function add(username: string, role: string) {
    const fields = { username, password: account.password };
    await call('accounts', 'POST', { ...fields, role }, owner);
    return cookieOf(await call('login', 'POST', fields));
  }
  const teacher = await add('teacher', 'admin');
  const reader = await add('reader', 'student');
  const other = await add('peer', 'student');
  const history = (viewer: string, name = 'reader') => call('accounts/' + name + '/activity', 'GET', undefined, viewer);
  const pkg = { ...lesson, questions: [{ ...lesson.questions[0], choices: ['first','second'] }],
    solutions: [{ ...lesson.solutions[0], correct: 1 }] };
  await call('sets', 'POST', pkg, owner);
  const record = (action: string, revision: number, value?: number, username = 'reader') =>
    call('sets/test-set/activity', 'POST', { username, question: 'test-q', action, revision, value }, reader);
  const release = (revision: number, solutionsVisible: boolean) =>
    call('sets/test-set','PATCH',{revision, questionsVisible: true, solutionsVisible},owner);
  assert.equal((await record('question', 1)).status, 404);
  await release(1, false);
  await call('sets/test-set', 'GET', undefined, reader);
  // Simulate a set uploaded before this feature.
  db.write('DELETE FROM activity_questions');
  assert.equal((await record('question', 2)).status, 200);
  assert.equal((await record('check', 2, 0)).status, 403);
  assert.equal((await record('hint', 2, 1)).status, 403);
  await release(2, true);
  assert.equal((await record('complete', 2)).status, 409);
  assert.equal((await record('complete', 3, undefined, 'peer')).status, 403);
  assert.equal((await record('hint', 3, 1)).status, 200);
  assert.equal((await record('check', 3, 2)).status, 400);
  for (const choice of [0,1]) assert.equal((await record('check', 3, choice)).status, 200);
  for (const action of ['solution','complete','incomplete']) assert.equal((await record(action, 3)).status, 200);
  for (const viewer of [reader,other]) assert.equal((await history(viewer)).status, 403);
  assert.equal((await history('')).status, 401);
  assert.equal((await history(teacher,'teacher')).status, 404);
  for (const viewer of [teacher,owner]) {
    const { entries } = await (await history(viewer)).json();
    assert.deepEqual(entries.map((e: {kind:string})=>e.kind), ['incomplete','complete','solution','correct','incorrect','hint','question','set','signin']);
    assert.equal(entries[5].hint, 1);
    assert.equal(entries[3].title, lesson.title);
    assert.equal(entries[3].number, 1);
  }
  const {accounts} = await (await call('accounts','GET',undefined,owner)).json();
  const version = accounts.find((a:{username:string})=>a.username==='reader').version;
  assert.equal((await call('accounts/reader','DELETE',{version},owner)).status,200);
  await add('reader','student');
  assert.equal((await (await history(owner)).json()).entries.length, 1);
});
