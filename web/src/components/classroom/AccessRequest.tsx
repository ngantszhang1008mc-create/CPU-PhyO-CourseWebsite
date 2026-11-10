import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { courseApi, CourseError, explain } from '../../lib/classroom';
import { GoogleSignup, type GoogleChallenge } from './GoogleSignup';
import './access-request.css';

export function AccessRequest({
  studentNumber,
  onReturn,
}: {
  studentNumber: string;
  onReturn: (signIn: boolean) => void;
}) {
  const [membership, setMembership] = useState('');
  const [challenge, setChallenge] = useState<GoogleChallenge>();
  const [credential, setCredential] = useState('');
  const [result, setResult] = useState<'pending' | 'allowed'>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const email = 's' + studentNumber + '@cpu.edu.hk';

  useEffect(() => {
    heading.current?.focus();
  }, [result]);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (challenge && !credential)) return;
    const fields = new FormData(event.currentTarget);
    const studentName = String(fields.get('studentName') ?? '').trim();
    const justification = String(fields.get('justification') ?? '').trim();
    if (!studentName || (membership === 'no' && !justification)) {
      setError(!studentName ? 'Enter your name.' : 'Explain why you would like classroom access.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (!challenge) {
        setChallenge(
          await courseApi<GoogleChallenge>('access-requests/challenge', {
            method: 'POST',
            body: JSON.stringify({ studentNumber }),
          }),
        );
      } else {
        await courseApi('access-requests', {
          method: 'POST',
          body: JSON.stringify({
            studentNumber,
            studentName,
            yearOfStudy: Number(fields.get('yearOfStudy')),
            phyTeamMember: membership === 'yes',
            justification: membership === 'no' ? justification : '',
            googleNonce: challenge.nonce,
            googleCredential: credential,
          }),
        });
        setResult('pending');
      }
    } catch (err) {
      if (
        err instanceof CourseError &&
        err.status === 409 &&
        err.code === 'student_access_granted'
      ) {
        setResult('allowed');
      } else {
        setError(explain(err));
        if (err instanceof CourseError && err.status === 403) {
          setCredential('');
          setChallenge(undefined);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card access-request" aria-labelledby="request-heading">
      <h1 id="request-heading" tabIndex={-1} ref={heading}>
        {result === 'pending'
          ? 'Request submitted'
          : result === 'allowed'
            ? 'Registration available'
            : 'Request classroom access'}
      </h1>
      {result ? (
        <p>
          {result === 'pending'
            ? `Your request for ${email} is awaiting review. Once approved, enter your CPU account number again to register.`
            : `An administrator has authorized ${email}. Return to registration to create your account.`}
        </p>
      ) : (
        <>
          <p>
            Registration for <strong>{email}</strong> needs administrator approval.
          </p>
          <form onSubmit={submit} aria-labelledby="request-heading">
            <label>
              Student name
              <input
                name="studentName"
                autoComplete="name"
                required
                maxLength={100}
                disabled={busy}
              />
            </label>
            <label>
              Year of study
              <select name="yearOfStudy" required defaultValue="" disabled={busy}>
                <option value="" disabled>
                  Select your year
                </option>
                {[1, 2, 3, 4, 5, 6].map((year) => (
                  <option key={year} value={year}>
                    S{year}
                  </option>
                ))}
              </select>
            </label>
            <fieldset disabled={busy}>
              <legend>Are you a Physics Team member?</legend>
              <div className="account-actions">
                {['Yes', 'No'].map((answer) => (
                  <label key={answer}>
                    <input
                      type="radio"
                      name="phyTeamMember"
                      value={answer.toLowerCase()}
                      checked={membership === answer.toLowerCase()}
                      onChange={(event) => setMembership(event.target.value)}
                      required
                    />{' '}
                    {answer}
                  </label>
                ))}
              </div>
            </fieldset>
            {membership === 'no' && (
              <label>
                Why would you like classroom access?
                <textarea name="justification" rows={3} maxLength={1000} required disabled={busy} />
              </label>
            )}
            {challenge && !credential ? (
              <GoogleSignup key={challenge.nonce} challenge={challenge} selected={setCredential} />
            ) : (
              <button className="primary" disabled={busy}>
                {credential ? 'Submit request' : 'Verify school account'}
              </button>
            )}
            {error && (
              <p role="alert" className="course-error">
                {error}
              </p>
            )}
          </form>
        </>
      )}
      <div className="account-actions">
        <button className="text-button" disabled={busy} onClick={() => onReturn(false)}>
          Back to registration
        </button>
        {result === 'pending' && (
          <button className="text-button" onClick={() => onReturn(true)}>
            Sign in
          </button>
        )}
      </div>
    </section>
  );
}
