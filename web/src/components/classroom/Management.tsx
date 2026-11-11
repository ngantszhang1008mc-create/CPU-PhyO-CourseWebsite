import { useState, type SubmitEvent } from 'react';
import { PackageUpload } from './PackageUpload';
import { courseApi, explain, type SetInfo } from '../../lib/classroom';

import { QuickRegistration } from './QuickRegistration';
import { AccessRequestReview } from './AccessRequestReview';
import { ValidityField, validityDays, formatRegistrationValidity } from './ValidityField';
import { GoogleSettings } from './GoogleSettings';
import { AccountRoleField } from './CreateAccount';

export function Management({
  sets,
  refresh,
  isPrimary,
}: {
  sets: SetInfo[];
  refresh: () => Promise<void>;
  isPrimary: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [invite, setInvite] = useState<{
    code: string;
    link: string;
    expires: number | null;
    studentNumber?: string;
  }>();
  const [registrationRevision, setRegistrationRevision] = useState(0);
  const refreshRegistrations = () => setRegistrationRevision((revision) => revision + 1);
  const [customCode, setCustomCode] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'student'>('student');
  const [studentEmail, setStudentEmail] = useState('');
  async function makeInvite(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const role = fields.get('role');
    const code = customCode.trim();
    setBusy(true);
    setStatus('');
    setInvite(undefined);
    try {
      const result = await courseApi<{ token: string; expires: number | null }>('invites', {
        method: 'POST',
        body: JSON.stringify({
          role,
          ...(code && { code }),
          ...(role === 'student' && {
            studentEmail: studentEmail.trim(),
            validityDays: validityDays(fields),
          }),
        }),
      });
      setInvite({
        code: result.token,
        expires: result.expires,
        studentNumber: role === 'student' ? studentEmail.trim().slice(1, 8) : undefined,
        link: location.origin + '/classroom/#invite=' + encodeURIComponent(result.token),
      });
      if (role === 'student') refreshRegistrations();
      setCustomCode('');
      setStudentEmail('');
    } catch (err) {
      setStatus(explain(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="admin-tools">
      <summary>Manage classroom</summary>
      <AccessRequestReview revision={registrationRevision} onApproved={refreshRegistrations} />
      <div className="manager-grid">
        <QuickRegistration
          revision={registrationRevision}
          onAuthorized={refreshRegistrations}
          onCancelled={(studentNumber) =>
            setInvite((current) => (current?.studentNumber === studentNumber ? undefined : current))
          }
        />
        <section>
          <h3>Upload a problem set</h3>
          <p>Choose the compiled package from your React/TypeScript project.</p>
          <PackageUpload sets={sets} onSaved={refresh} />
          <a href="/course-package-guide.md" download>
            Download the agent package guide
          </a>
        </section>
        <section>
          <h3>{isPrimary ? 'Create an invitation' : 'Invite a student'}</h3>
          <form onSubmit={makeInvite} onChange={() => setInvite(undefined)}>
            <AccountRoleField
              isPrimary={isPrimary}
              disabled={busy}
              onRoleChange={(role) => {
                setInviteRole(role);
                setCustomCode('');
              }}
            />
            {inviteRole === 'student' && (
              <label>
                Student’s school Google email
                <input
                  required
                  type="email"
                  name="studentEmail"
                  value={studentEmail}
                  onChange={(e) => setStudentEmail(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                  placeholder="s1234567@cpu.edu.hk"
                />
                <small>The student must verify this Google account when joining.</small>
              </label>
            )}
            <label>
              Custom invitation code (optional)
              <input
                name="code"
                type="text"
                value={customCode}
                onChange={(e) => setCustomCode(e.target.value)}
                maxLength={256}
                placeholder={
                  inviteRole === 'student' ? 'e.g. s1234567@cpu.edu.hk' : 'Choose a private code'
                }
                disabled={busy}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="invite-code-help"
              />
              <small id="invite-code-help">Leave blank to generate a random code.</small>
            </label>
            {inviteRole === 'student' && (
              <button
                type="button"
                disabled={busy || !studentEmail.trim()}
                onClick={() => {
                  setInvite(undefined);
                  setCustomCode(studentEmail.trim());
                }}
              >
                Use email as code
              </button>
            )}
            {inviteRole === 'student' && <ValidityField disabled={busy} />}
            <button disabled={busy}>Create invitation</button>
          </form>
          {invite && (
            <div className="invitation-result">
              <p role="status">
                {invite.expires === null
                  ? 'Invitation ready. It can be used once, until cancelled.'
                  : `Invitation ready. It can be used once and expires on ${formatRegistrationValidity(invite.expires)}.`}
              </p>
              <label>
                Invitation code
                <input readOnly value={invite.code} onFocus={(e) => e.target.select()} />
              </label>
              <label>
                Invitation link
                <input readOnly value={invite.link} onFocus={(e) => e.target.select()} />
              </label>
            </div>
          )}
        </section>
      </div>
      {isPrimary && <GoogleSettings />}
      <p role="status">{status}</p>
    </details>
  );
}

export function Visibility({ info, updated, onModify }: { info: SetInfo; updated: () => Promise<void>; onModify: () => void }) {
  const [questionsVisible, setQuestions] = useState(info.questionsVisible);
  const [solutionsVisible, setSolutions] = useState(info.solutionsVisible);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await courseApi('sets/' + encodeURIComponent(info.id), {
        method: 'PATCH',
        body: JSON.stringify({ revision: info.revision, questionsVisible, solutionsVisible }),
      });
      await updated();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="visibility" onSubmit={submit}>
      <strong>Student visibility</strong>
      <label>
        <input
          type="checkbox"
          checked={questionsVisible}
          onChange={(e) => setQuestions(e.target.checked)}
        />{' '}
        Questions
      </label>
      <label>
        <input
          type="checkbox"
          checked={solutionsVisible}
          onChange={(e) => setSolutions(e.target.checked)}
        />{' '}
        Solutions
      </label>
      <button
        disabled={
          busy ||
          (questionsVisible === info.questionsVisible && solutionsVisible === info.solutionsVisible)
        }
      >
        Save visibility
      </button>
      <button type="button" className="modify-set" onClick={onModify} disabled={busy}>Modify problem set</button>
      {error && (
        <p className="course-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
