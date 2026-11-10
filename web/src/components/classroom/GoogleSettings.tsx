import { useEffect, useState, type SubmitEvent } from 'react';
import { courseApi, explain } from '../../lib/classroom';

export function GoogleSettings() {
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    courseApi<{ clientId: string }>('settings/google')
      .then((result) => {
        if (active) setClientId(result.clientId);
      })
      .catch((err) => {
        if (active) setMessage(explain(err));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await courseApi('settings/google', {
        method: 'PATCH',
        body: JSON.stringify({ clientId: clientId.trim() }),
      });
      setMessage('Google client ID saved.');
    } catch (err) {
      setMessage(explain(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="account-settings">
      <summary>Google signup settings</summary>
      <p>
        Create a <strong>Web application</strong> client in Google Cloud. Add{' '}
        <code>{location.origin}</code> to its authorized JavaScript origins.
      </p>
      <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">
        Open Google Auth Platform
      </a>
      <form onSubmit={save}>
        <label>
          Google client ID
          <input
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="…apps.googleusercontent.com"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        <button disabled={busy}>Save client ID</button>
        <span role="status">{message}</span>
      </form>
    </details>
  );
}
