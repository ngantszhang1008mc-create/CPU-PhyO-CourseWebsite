import type { DurableObjectState } from '@cloudflare/workers-types';
import { CourseApi } from './api.ts';
import { digest, MailDeliveryError, type SendReset } from './security.ts';
import type { Database } from './storage.ts';

interface Env {
  OWNER_SETUP_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESET_EMAIL_FROM?: string;
  GOOGLE_MAIL_SCRIPT_URL?: string;
  GOOGLE_MAIL_SECRET?: string;
  CLASSROOM_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  LEGACY_PRIMARY_USERNAME?: string;
  COURSES: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  ASSETS: { fetch(request: Request): Promise<Response> };
}

// Google's ContentService returns its acknowledgement through a separate GET.
async function googleMailResponse(scriptUrl: string, payload: Record<string, string>) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(scriptUrl))
    return { postStatus: 0, status: 0, reply: 'invalid URL' };
  let postStatus = 0;
  let status = 0;
  let content: string;
  let response: Response;
  try {
    response = await fetch(scriptUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    postStatus = status = response.status;
    for (let hop = 0; hop < 4 && status >= 300 && status < 400; hop++) {
      const target = new URL(response.headers.get('location') ?? '', scriptUrl);
      if (target.origin === 'https://accounts.google.com')
        return { postStatus, status, reply: 'authorization required' };
      if (target.origin !== 'https://script.googleusercontent.com')
        return { postStatus, status, reply: 'unexpected redirect' };
      await response.body?.cancel();
      response = await fetch(target.href, { method: 'GET', redirect: 'manual' });
      status = response.status;
    }
    if (status === 401 || status === 403)
      return { postStatus, status, reply: 'authorization required' };
    content = (await response.text()).trim();
  } catch {
    return {
      postStatus,
      status,
      reply: postStatus ? 'could not read acknowledgement' : 'POST failed',
    };
  }
  // Only return recognized responses or a category, never Google response bodies or links.
  let reply = 'unexpected';
  if (response.ok && (content === 'sent' || content === 'rejected')) reply = content;
  else if (/script function not found/i.test(content)) reply = 'missing function';
  else if (/permission|authorization is required/i.test(content)) reply = 'authorization required';
  else if (/unable to open the file/i.test(content)) reply = 'Google could not open deployment';
  else if (/exception|script completed but did not return anything/i.test(content))
    reply = 'script error or empty return';
  else if (response.headers.get('content-type')?.includes('text/html')) reply = 'unexpected HTML';
  return { postStatus, status: response.status, reply };
}

function resetSender(env: Env): SendReset | undefined {
  const scriptUrl = env.GOOGLE_MAIL_SCRIPT_URL?.trim();
  const scriptSecret = env.GOOGLE_MAIL_SECRET;
  const gmailReady = scriptUrl && scriptSecret && scriptSecret.length >= 32;
  if (!gmailReady && !(env.RESEND_API_KEY && env.RESET_EMAIL_FROM)) return undefined;
  return async ({ email, username, token }) => {
    const link = new URL('/classroom/', env.CLASSROOM_ORIGIN);
    link.hash = 'reset=' + token;
    const subject = 'Reset your CPU Physics Olympiad classroom password';
    const text = `A password reset was requested for your classroom account ${username}.

Choose a new password within 30 minutes using this link:
${link.href}

If you did not request this, you can ignore this email.`;
    if (gmailReady) {
      const result = await googleMailResponse(scriptUrl, {
        secret: scriptSecret,
        email,
        subject,
        text,
      });
      if (result.reply === 'invalid URL') throw new MailDeliveryError('url');
      if (result.reply === 'authorization required') throw new MailDeliveryError('permission');
      if (result.reply === 'rejected') throw new MailDeliveryError('rejected');
      if (result.reply !== 'sent') throw new MailDeliveryError('provider');
      return;
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.RESET_EMAIL_FROM, to: [email], subject, text }),
    });
    if (!response.ok) throw new Error('Email provider rejected delivery.');
  };
}

export class CourseStore {
  private api: CourseApi;
  constructor(ctx: DurableObjectState, env: Env) {
    const storage = ctx.storage;
    const db: Database = {
      all: <T extends object>(
        query: string,
        ...bindings: (string | number | ArrayBuffer | null)[]
      ) => storage.sql.exec(query, ...bindings).toArray() as T[],
      write: (query, ...bindings) => {
        storage.sql.exec(query, ...bindings);
      },
      atomic: (action) => storage.transactionSync(action),
    };
    this.api = new CourseApi(
      db,
      env.OWNER_SETUP_TOKEN,
      env.LEGACY_PRIMARY_USERNAME,
      env.GOOGLE_CLIENT_ID,
      undefined,
      resetSender(env),
      (job) => ctx.waitUntil(job),
      env.GOOGLE_MAIL_SCRIPT_URL
        ? async () => {
            const url = env.GOOGLE_MAIL_SCRIPT_URL!.trim();
            return {
              ...(await googleMailResponse(url, { probe: 'connectivity' })),
              deploymentFingerprint: await digest(url),
            };
          }
        : undefined,
    );
  }
  fetch(request: Request) {
    return this.api.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname.startsWith('/api/'))
      return env.COURSES.getByName('classroom').fetch(request);
    return env.ASSETS.fetch(request);
  },
};
