import { useState, type SubmitEvent } from 'react';
import { courseApi, explain } from '../../lib/classroom';

export function PasswordRecovery({ token, close }: { token?: string; close: () => void }) {
  const [done, setDone] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setError('');
    if (token && fields.get('newPassword') !== fields.get('confirmation')) {
      setError('Enter the same new password in both fields.');
      return;
    }
    setBusy(true);
    try {
      const result = await courseApi<{ emailConfigured?: boolean }>(
        token ? 'password-recovery/complete' : 'password-recovery',
        {
          method: 'POST',
          body: JSON.stringify(
            token
              ? { token, newPassword: fields.get('newPassword') }
              : { username: String(fields.get('username')).trim() },
          ),
        },
      );
      setEmailConfigured(Boolean(result.emailConfigured));
      setDone(true);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-card">
      <h1>{token ? 'Reset password' : 'Forgot password?'}</h1>
      {done ? (
        <p role="status">
          {token
            ? 'Your password has been changed. Sign in with your new password.'
            : !emailConfigured
              ? 'Contact your classroom administrator to verify your identity and complete the manual reset.'
              : 'If your account is eligible for email recovery, check your CPU school inbox and spam folder. Otherwise, contact your classroom administrator to complete the manual reset.'}
        </p>
      ) : (
        <form onSubmit={submit}>
          {token ? (
            <>
              <label>
                New password
                <input
                  type="password"
                  name="newPassword"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                />
              </label>
              <label>
                Confirm new password
                <input
                  type="password"
                  name="confirmation"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                />
              </label>
            </>
          ) : (
            <>
              <p>
                Enter your classroom username. Students with a linked CPU account can receive a
                reset email. Other accounts use an administrator reset.
              </p>
              <label>
                Classroom username
                <input
                  name="username"
                  required
                  maxLength={48}
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </label>
            </>
          )}
          <button disabled={busy} className="primary">
            {token ? 'Save new password' : 'Request password reset'}
          </button>
          {error && (
            <p className="course-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      <button type="button" className="text-button" disabled={busy} onClick={close}>
        Back to sign in
      </button>
    </section>
  );
}
