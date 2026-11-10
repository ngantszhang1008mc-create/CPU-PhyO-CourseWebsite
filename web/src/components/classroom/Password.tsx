import { useState, type SubmitEvent } from 'react';
import { courseApi, explain } from '../../lib/classroom';

export function Password() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function change(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setMessage('');
    try {
      await courseApi('password', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      form.reset();
      setMessage('Password changed. Other sessions have been signed out.');
    } catch (err) {
      setMessage(explain(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="account-settings">
      <summary>Change password</summary>
      <form onSubmit={change}>
        <label>
          Current password
          <input type="password" name="currentPassword" autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input
            type="password"
            name="newPassword"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
        <button disabled={busy}>Update password</button>
        <span role="status">{message}</span>
      </form>
    </details>
  );
}
