import { useEffect, useState, type SubmitEvent } from 'react';
import { courseApi, explain, roleLabel, type CourseUser } from '../../lib/classroom';
import { AccountRoleField, CreateAccount } from './CreateAccount';

interface Account extends CourseUser {
  active: boolean;
  version: string;
  resetRequested?: boolean;
  mailIssue?: string;
  recoveryEmailLinked?: boolean;
  cpuEmail?: string;
}

function AccountRow({
  account,
  viewer,
  refresh,
  onReset,
}: {
  account: Account;
  viewer: CourseUser;
  refresh: () => Promise<void>;
  onReset: (updated: Account) => void;
}) {
  const own = viewer.username === account.username;
  const canManage = !own && !account.isPrimary && (viewer.isPrimary || account.role === 'student');
  const [action, setAction] = useState<'edit' | 'delete' | 'reset'>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !action || action === 'reset') return;
    const fields = new FormData(event.currentTarget);
    const deleting = action === 'delete';
    const body = deleting
      ? { version: account.version }
      : {
          version: account.version,
          role: fields.get('role'),
          active: fields.get('access') === 'active',
        };
    setBusy(true);
    setMessage('');
    try {
      await courseApi('accounts/' + encodeURIComponent(account.username), {
        method: deleting ? 'DELETE' : 'PATCH',
        body: JSON.stringify(body),
      });
      setAction(undefined);
      await refresh();
    } catch (err) {
      setMessage(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const newPassword = new FormData(form).get('newPassword');
    setBusy(true);
    setMessage('');
    try {
      const result = await courseApi<{ account: Account }>(
        'accounts/' + encodeURIComponent(account.username) + '/password',
        { method: 'POST', body: JSON.stringify({ version: account.version, newPassword }) },
      );
      form.reset();
      setAction(undefined);
      onReset(result.account);
    } catch (err) {
      setMessage(explain(err));
    } finally {
      setBusy(false);
    }
  }

  function open(next: typeof action) {
    setMessage('');
    setAction(next);
  }

  return (
    <li className="account-row">
      <div className="account-summary">
        <strong>
          {account.username}
          {own && <small> (you)</small>}
        </strong>
        <span>{roleLabel(account)}</span>
        <span>{account.active ? 'Active' : 'Suspended'}</span>
        {canManage && !action && (
          <div className="account-actions">
            <button
              type="button"
              aria-label={'Edit ' + account.username}
              onClick={() => open('edit')}
            >
              Edit
            </button>
            <button
              type="button"
              aria-label={'Reset password for ' + account.username}
              onClick={() => open('reset')}
            >
              Reset password
            </button>
            <button
              type="button"
              aria-label={'Delete ' + account.username}
              onClick={() => open('delete')}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {canManage && account.role === 'student' && (
        <small>
          {account.cpuEmail
            ? <>CPU email <strong>{account.cpuEmail}</strong></>
            : account.recoveryEmailLinked ? 'Recovery email linked' : 'Manual password recovery'}
        </small>
      )}
      {canManage && account.mailIssue && <p className="course-error">{account.mailIssue}</p>}
      {canManage && account.resetRequested && (
        <p>
          <strong>Password reset requested.</strong> Verify the requester’s identity before setting
          a new password.
        </p>
      )}
      {canManage && action === 'reset' && (
        <form className="account-editor" onSubmit={resetPassword}>
          <label>
            New password for {account.username}
            <input
              type="password"
              name="newPassword"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              disabled={busy}
              aria-describedby={'reset-help-' + account.username}
            />
            <small id={'reset-help-' + account.username}>
              Use at least 12 characters. Saving signs this user out.
            </small>
          </label>
          <div className="account-actions">
            <button type="submit" className="primary" disabled={busy}>
              Save new password
            </button>
            <button type="button" disabled={busy} onClick={() => open(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {canManage && (action === 'edit' || action === 'delete') && (
        <form className="account-editor" onSubmit={submit}>
          {action === 'edit' ? (
            <>
              <AccountRoleField isPrimary={viewer.isPrimary} role={account.role} disabled={busy} />
              <label>
                Classroom access
                <select
                  name="access"
                  defaultValue={account.active ? 'active' : 'suspended'}
                  disabled={busy}
                >
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                </select>
              </label>
            </>
          ) : (
            <p>
              Permanently delete <strong>{account.username}</strong> and sign them out?
            </p>
          )}
          <div className="account-actions">
            <button
              type="submit"
              className={action === 'delete' ? 'delete-account' : 'primary'}
              disabled={busy}
            >
              {action === 'delete' ? 'Confirm delete' : 'Save access'}
            </button>
            <button type="button" disabled={busy} onClick={() => open(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && (
        <p role="alert" className="course-error">
          {message}
        </p>
      )}
    </li>
  );
}

function AccountDirectory({ viewer }: { viewer: CourseUser }) {
  const [accounts, setAccounts] = useState<Account[]>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function passwordReset(updated: Account) {
    setAccounts((current) =>
      current?.map((account) => (account.username === updated.username ? updated : account)),
    );
    setNotice('Password reset for ' + updated.username + '.');
  }
  async function refresh() {
    setError('');
    try {
      setAccounts((await courseApi<{ accounts: Account[] }>('accounts')).accounts);
    } catch (err) {
      setError(explain(err));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="account-directory">
      <div className="directory-tools">
        <details>
          <summary>Add account</summary>
          <CreateAccount isPrimary={viewer.isPrimary} onCreated={refresh} />
        </details>
        <button type="button" onClick={() => void refresh()}>
          Refresh list
        </button>
      </div>
      {error && (
        <p className="course-error" role="alert">
          {error}
        </p>
      )}
      {!accounts && !error && <p role="status">Loading accounts…</p>}
      <output aria-live="polite">{notice}</output>
      {accounts && (
        <ul aria-label="Classroom accounts">
          {accounts.map((account) => (
            <AccountRow
              key={account.username + ':' + account.version}
              account={account}
              viewer={viewer}
              onReset={passwordReset}
              refresh={refresh}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function Accounts({ viewer }: { viewer: CourseUser }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="admin-tools" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Manage accounts</summary>
      {open && <AccountDirectory viewer={viewer} />}
    </details>
  );
}
