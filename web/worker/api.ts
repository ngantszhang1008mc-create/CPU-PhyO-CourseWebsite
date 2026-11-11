import { MAX_PACKAGE_BYTES, parseLessonPackage } from '../src/lib/lesson-package.ts';
import { initialize, readPart, storePart, type Database } from './storage.ts';
import {
  beginAccessRequest,
  listAccessRequests,
  reviewAccessRequest,
  submitAccessRequest,
} from './access-requests.ts';
import {
  allowStudentRegistration,
  beginGoogleSignup,
  cancelStudentRegistration,
  getStudentRegistration,
  listStudentRegistrations,
  getGoogleClientId,
  setGoogleClientId,
  type VerifyGoogle,
  changePassword,
  createAccount,
  createInvite,
  currentUser,
  hasUsers,
  HttpError,
  limitAttempts,
  listAccounts,
  manageAccount,
  sessionKey,
  login,
  logout,
  register,
  rejectPrimaryField,
  resetAccountPassword,
  requestPasswordRecovery,
  redeemPasswordReset,
  type SendReset,
  validSetupToken,
  type User,
} from './security.ts';

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function json(value: unknown, status = 200, cookie?: string) {
  const headers = new Headers(jsonHeaders);
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

function sessionResponse(session: { user: User; cookie: string }) {
  return json({ user: session.user, setupRequired: false }, 200, session.cookie);
}

async function readObject(request: Request, maxBytes = 4096): Promise<Record<string, unknown>> {
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw new HttpError(415, 'Send an application/json request.');
  }
  if (Number(request.headers.get('Content-Length')) > maxBytes)
    throw new HttpError(413, 'Upload exceeds the size limit.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON object is required.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pieces: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'Upload exceeds the size limit.');
      }
      pieces.push(decoder.decode(value, { stream: true }));
    }
    pieces.push(decoder.decode());
    const payload: unknown = JSON.parse(pieces.join(''));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'A valid UTF-8 JSON object is required.');
  } finally {
    reader.releaseLock();
  }
}

interface SetRow {
  id: string;
  title: string;
  revision: number;
  questions_visible: number;
  solutions_visible: number;
}

function summary(row: SetRow) {
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    questionsVisible: Boolean(row.questions_visible),
    solutionsVisible: Boolean(row.solutions_visible),
  };
}

export class CourseApi {
  private db: Database;
  private ownerToken?: string;
  private googleClientId?: string;
  private verifyGoogle?: VerifyGoogle;
  private sendReset?: SendReset;
  private probeMail?: () => Promise<{ postStatus: number; status: number; reply: string }>;
  private waitUntil?: (job: Promise<void>) => void;

  constructor(
    db: Database,
    ownerToken?: string,
    legacyPrimaryUsername?: string,
    googleClientId?: string,
    verifyGoogle?: VerifyGoogle,
    sendReset?: SendReset,
    waitUntil?: (job: Promise<void>) => void,
    probeMail?: () => Promise<{ postStatus: number; status: number; reply: string }>,
  ) {
    this.db = db;
    this.ownerToken = ownerToken;
    this.googleClientId = googleClientId;
    this.verifyGoogle = verifyGoogle;
    this.sendReset = sendReset;
    this.waitUntil = waitUntil;
    this.probeMail = probeMail;
    initialize(db, legacyPrimaryUsername);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message, code: error.code }, error.status);
      return json({ error: 'The classroom service could not complete this request.' }, 500);
    }
  }

  private async handle(request: Request) {
    const { origin, pathname } = new URL(request.url);
    const method = request.method;
    const db = this.db;
    if (method !== 'GET' && request.headers.get('Origin') !== origin) {
      throw new HttpError(403, 'A same-origin request is required.');
    }

    if (method === 'POST' && pathname === '/api/password-recovery') {
      const { username } = await readObject(request);
      if (typeof username !== 'string' || !/^[A-Za-z0-9._-]{3,48}$/.test(username))
        throw new HttpError(400, 'Enter your classroom username.');
      await limitAttempts(db, request, 'password-recovery');
      const job = requestPasswordRecovery(db, username, this.sendReset);
      if (this.waitUntil) this.waitUntil(job);
      else await job;
      return json({ accepted: true, emailConfigured: Boolean(this.sendReset) }, 202);
    }
    if (method === 'POST' && pathname === '/api/password-recovery/complete') {
      const success = await limitAttempts(db, request, 'password-recovery');
      await redeemPasswordReset(db, await readObject(request));
      success();
      return json({ changed: true });
    }
    if (method === 'POST' && pathname === '/api/signup/google/challenge') {
      const input = await readObject(request);
      const numberLookup =
        !('token' in input) &&
        typeof input.studentNumber === 'string' &&
        /^[0-9]{7}$/.test(input.studentNumber);
      const success = await limitAttempts(db, request, numberLookup ? 'student-number' : undefined);
      const result = await beginGoogleSignup(
        db,
        input,
        request,
        this.ownerToken,
        this.googleClientId,
      );
      success();
      return json(result);
    }
    if (method === 'POST' && pathname === '/api/access-requests/challenge') {
      const success = await limitAttempts(db, request, 'access-request');
      const result = await beginAccessRequest(
        db,
        await readObject(request),
        request,
        this.googleClientId,
      );
      success();
      return json(result);
    }
    if (method === 'POST' && pathname === '/api/access-requests') {
      const success = await limitAttempts(db, request, 'access-request');
      const created = await submitAccessRequest(
        db,
        await readObject(request, 20 * 1024),
        this.googleClientId,
        this.verifyGoogle,
      );
      success();
      return json({ status: 'pending' }, created ? 201 : 200);
    }
    if (method === 'POST' && (pathname === '/api/login' || pathname === '/api/register')) {
      const success = await limitAttempts(db, request);
      const input = await readObject(request, pathname === '/api/register' ? 20 * 1024 : 4096);
      const session =
        pathname === '/api/login'
          ? await login(db, input)
          : await register(db, input, this.ownerToken, this.googleClientId, this.verifyGoogle);
      success();
      return sessionResponse(session);
    }
    if (method === 'POST' && pathname === '/api/logout') {
      return json({ user: null }, 200, await logout(db, request));
    }
    const key = await sessionKey(request);
    const user = currentUser(db, key);
    function requireAdmin(): User {
      const current = currentUser(db, key);
      if (!current) throw new HttpError(401, 'Please sign in.');
      if (current.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
      return current;
    }
    if (method === 'GET' && pathname === '/api/session') {
      return json({
        user: user ?? null,
        setupRequired: !hasUsers(db) && validSetupToken(this.ownerToken),
      });
    }
    if (!user) throw new HttpError(401, 'Please sign in.');
    if (method === 'POST' && pathname === '/api/password') {
      const success = await limitAttempts(db, request);
      const session = await changePassword(db, user, await readObject(request), key);
      success();
      return sessionResponse(session);
    }
    const admin = user.role === 'admin';
    if (method !== 'GET' && !admin) throw new HttpError(403, 'Administrator access is required.');
    if (method === 'POST' && pathname === '/api/settings/mail/check') {
      if (!requireAdmin().isPrimary) throw new HttpError(403, 'Primary administrator required.');
      if (!this.probeMail) throw new HttpError(503, 'Gmail deployment is not configured.');
      return json(await this.probeMail());
    }
    if (method === 'GET' && pathname === '/api/access-requests') {
      requireAdmin();
      return json({ requests: listAccessRequests(db) });
    }
    const accessReview = /^\/api\/access-requests\/([a-f0-9]{64})\/review$/.exec(pathname);
    if (method === 'POST' && accessReview) {
      requireAdmin();
      return json(
        await reviewAccessRequest(db, accessReview[1], await readObject(request), requireAdmin),
      );
    }
    if (pathname === '/api/settings/google' && (method === 'GET' || method === 'PATCH')) {
      const requirePrimary = () => {
        if (!requireAdmin().isPrimary)
          throw new HttpError(
            403,
            'Only the primary administrator can configure Google verification.',
          );
      };
      requirePrimary();
      if (method === 'GET') return json({ clientId: getGoogleClientId(db, this.googleClientId) });
      const input = await readObject(request);
      return json(
        db.atomic(() => {
          requirePrimary();
          return setGoogleClientId(db, input.clientId);
        }),
      );
    }
    if (pathname === '/api/accounts' && method === 'GET') {
      requireAdmin();
      return json({ accounts: listAccounts(db) });
    }
    const resetPath = /^\/api\/accounts\/([A-Za-z0-9._-]{3,48})\/password$/.exec(pathname);
    if (resetPath && method === 'POST') {
      const body = await readObject(request);
      rejectPrimaryField(body);
      return json(await resetAccountPassword(db, resetPath[1].toLowerCase(), body, requireAdmin));
    }
    const accountPath = /^\/api\/accounts\/([A-Za-z0-9._-]{3,48})$/.exec(pathname);
    if (accountPath && (method === 'PATCH' || method === 'DELETE')) {
      const body = await readObject(request);
      rejectPrimaryField(body);
      const target = accountPath[1].toLowerCase();
      const update = method === 'PATCH' ? { role: body.role, active: body.active } : undefined;
      return json(db.atomic(() => manageAccount(db, requireAdmin(), target, body.version, update)));
    }
    if (method === 'POST' && pathname === '/api/accounts') {
      const account = await createAccount(db, await readObject(request), requireAdmin);
      return json({ user: account }, 201);
    }
    if (method === 'GET' && pathname === '/api/student-registrations') {
      requireAdmin();
      return json({ registrations: await listStudentRegistrations(db) });
    }
    const registrationPath = /^\/api\/student-registrations\/([^/]+)$/.exec(pathname);
    if (registrationPath && (method === 'GET' || method === 'DELETE')) {
      requireAdmin();
      if (method === 'GET')
        return json({
          registration: await getStudentRegistration(db, registrationPath[1]),
        });
      const input = await readObject(request);
      return json(
        await cancelStudentRegistration(db, registrationPath[1], input.version, requireAdmin),
      );
    }
    if (method === 'POST' && pathname === '/api/student-registrations') {
      const grant = await allowStudentRegistration(db, await readObject(request), requireAdmin);
      return json(grant, grant.created ? 201 : 200);
    }
    if (method === 'POST' && pathname === '/api/invites') {
      const input = await readObject(request);
      rejectPrimaryField(input);
      return json(
        await createInvite(
          db,
          input.role,
          input.code,
          input.studentEmail,
          requireAdmin,
          input.validityDays,
        ),
        201,
      );
    }
    if (pathname === '/api/sets') {
      if (method === 'GET') {
        const where = admin ? '' : ' WHERE questions_visible=1 OR solutions_visible=1';
        return json({
          sets: db.all<SetRow>('SELECT * FROM lessons' + where + ' ORDER BY title,id').map(summary),
        });
      }
      if (method === 'POST') return this.savePackage(request, requireAdmin);
    }
    const match = /^\/api\/sets\/([a-z0-9][a-z0-9-]*)$/.exec(pathname);
    if (match) {
      const id = match[1];
      if (method === 'GET') {
        const row = this.lookup(id);
        if (!row || (!admin && !row.questions_visible && !row.solutions_visible))
          throw new HttpError(404, 'Problem set not found.');
        return json({
          set: summary(row),
          package: {
            format: 'cpu-lesson-v1',
            id,
            title: row.title,
            questions: admin || row.questions_visible ? readPart(db, id, 'questions') : [],
            solutions: admin || row.solutions_visible ? readPart(db, id, 'solutions') : [],
          },
        });
      }
      if (method === 'PUT') return this.savePackage(request, requireAdmin, id);
      if (method === 'PATCH') return this.visibility(id, await readObject(request), requireAdmin);
    }
    throw new HttpError(404, 'Endpoint not found.');
  }

  private lookup(id: string) {
    return this.db.all<SetRow>('SELECT * FROM lessons WHERE id=?', id)[0];
  }

  private async savePackage(request: Request, requireAdmin: () => User, editId?: string) {
    requireAdmin();
    const input = await readObject(request, MAX_PACKAGE_BYTES);
    let pkg;
    try {
      pkg = parseLessonPackage(input);
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : 'Invalid lesson package.');
    }
    if (editId && pkg.id !== editId) throw new HttpError(400, 'The problem set ID cannot change.');
    const previous = request.headers.get('If-Match');
    const info = this.db.atomic(() => {
      requireAdmin();
      const current = this.lookup(pkg.id);
      if (editId && !current) throw new HttpError(404, 'Problem set not found.');
      if ((current && previous !== `"${current.revision}"`) || (!current && previous !== null)) {
        throw new HttpError(409, 'The set revision has changed. Reopen the set to edit the latest version.');
      }
      const revision = (current?.revision ?? 0) + 1;
      this.db.write(
        `INSERT INTO lessons VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, revision=excluded.revision, questions_visible=excluded.questions_visible, solutions_visible=excluded.solutions_visible`,
        pkg.id,
        pkg.title,
        revision,
        editId ? current!.questions_visible : 0,
        editId ? current!.solutions_visible : 0,
      );
      this.db.write('DELETE FROM content WHERE id=?', pkg.id);
      storePart(this.db, pkg.id, 'questions', pkg.questions);
      storePart(this.db, pkg.id, 'solutions', pkg.solutions);
      return summary(this.lookup(pkg.id)!);
    });
    return json({ set: info }, previous === null ? 201 : 200);
  }

  private visibility(id: string, input: Record<string, unknown>, requireAdmin: () => User) {
    const { revision, questionsVisible, solutionsVisible } = input;
    if (
      !Number.isSafeInteger(revision) ||
      typeof questionsVisible !== 'boolean' ||
      typeof solutionsVisible !== 'boolean'
    ) {
      throw new HttpError(400, 'Supply the current revision and both visibility settings.');
    }
    const info = this.db.atomic(() => {
      requireAdmin();
      const current = this.lookup(id);
      if (!current) throw new HttpError(404, 'Problem set not found.');
      if (current.revision !== revision)
        throw new HttpError(409, 'The set revision has changed. Refresh before updating it.');
      this.db.write(
        'UPDATE lessons SET revision=revision+1, questions_visible=?, solutions_visible=? WHERE id=?',
        Number(questionsVisible),
        Number(solutionsVisible),
        id,
      );
      return summary(this.lookup(id)!);
    });
    return json({ set: info });
  }
}
