import { useState, type SubmitEvent } from 'react';
import { courseApi, explain, roleLabel, type CourseUser } from '../../lib/classroom';

export function AccountRoleField({
  isPrimary,
  role = 'student',
  disabled = false,
  onRoleChange,
}: {
  isPrimary: boolean;
  role?: CourseUser['role'];
  disabled?: boolean;
  onRoleChange?: (role: CourseUser['role']) => void;
}) {
  if (!isPrimary) return <input type="hidden" name="role" value="student" />;
  return (
    <label>
      Account role
      <select
        name="role"
        defaultValue={role}
        disabled={disabled}
        onChange={(e) => onRoleChange?.(e.target.value === 'admin' ? 'admin' : 'student')}
      >
        <option value="student">Student</option>
        <option value="admin">Administrator</option>
      </select>
    </label>
  );
}

export function CreateAccount({
  isPrimary,
  onCreated,
}: {
  isPrimary: boolean;
  onCreated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const input = Object.fromEntries(new FormData(form));
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const { user } = await courseApi<{ user: CourseUser }>('accounts', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      form.reset();
      await onCreated();
      setMessage(`${roleLabel(user)} account created. ${user.username} can now sign in.`);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 id="create-account-title">
        {isPrimary ? 'Create an account' : 'Create a student account'}
      </h3>
      <form aria-labelledby="create-account-title" onSubmit={submit}>
        <AccountRoleField isPrimary={isPrimary} disabled={busy} />
        <label>
          Username
          <input
            name="username"
            required
            minLength={3}
            maxLength={48}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        <label>
          Password
          <input
            name="password"
            required
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            aria-describedby="new-password-help"
            disabled={busy}
          />
          <small id="new-password-help">Use at least 12 characters.</small>
        </label>
        <button className="primary" disabled={busy}>
          Create account
        </button>
        {error && (
          <p className="course-error" role="alert">
            {error}
          </p>
        )}
        <output aria-live="polite">{message}</output>
      </form>
    </section>
  );
}
