import { useState, type SubmitEvent } from 'react';
import { CourseError, courseApi, explain } from '../../lib/classroom';
import { PasswordRecovery } from './PasswordRecovery';
import { AccessRequest } from './AccessRequest';
import { GoogleSignup, type GoogleChallenge } from './GoogleSignup';

export function Login({
  setupRequired,
  invite,
  onSuccess,
}: {
  setupRequired: boolean;
  invite: string;
  onSuccess: () => void;
}) {
  const [register, setRegister] = useState(Boolean(invite) || setupRequired);
  const [linkedToken, setLinkedToken] = useState(invite);
  const [studentNumber, setStudentNumber] = useState('');
  const [recover, setRecover] = useState(false);
  const [requestAccess, setRequestAccess] = useState(false);
  const [challenge, setChallenge] = useState<GoogleChallenge | { required: false }>();
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsInvitation = register && !setupRequired && !challenge;
  const needsGoogle = register && challenge?.required && !credential;

  function clearVerification() {
    setChallenge(undefined);
    setCredential('');
    setError('');
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || needsGoogle) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (needsInvitation) {
        setChallenge(
          await courseApi<GoogleChallenge | { required: false }>('signup/google/challenge', {
            method: 'POST',
            body: JSON.stringify(linkedToken ? { token: linkedToken } : { studentNumber }),
          }),
        );
      } else {
        const payload = Object.fromEntries(form);
        if (register && !setupRequired) {
          if (linkedToken) payload.token = linkedToken;
          else payload.studentNumber = studentNumber;
        }
        if (register && challenge?.required) {
          payload.googleNonce = challenge.nonce;
          payload.googleCredential = credential;
        }
        await courseApi(register ? 'register' : 'login', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onSuccess();
      }
    } catch (err) {
      if (
        needsInvitation &&
        !linkedToken &&
        /^[0-9]{7}$/.test(studentNumber) &&
        err instanceof CourseError &&
        err.status === 403 &&
        err.code === 'student_access_required'
      ) {
        setRequestAccess(true);
      } else {
        setError(explain(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (recover) return <PasswordRecovery close={() => setRecover(false)} />;
  if (requestAccess)
    return (
      <AccessRequest
        studentNumber={studentNumber}
        onReturn={(signIn) => {
          clearVerification();
          setRegister(!signIn);
          setRequestAccess(false);
        }}
      />
    );

  return (
    <section className="auth-card">
      <h1>
        {register
          ? setupRequired
            ? 'Set up the classroom'
            : linkedToken
              ? 'Join the classroom'
              : 'Register as Phy Team Member'
          : 'Classroom sign in'}
      </h1>
      <form onSubmit={submit}>
        {needsInvitation ? (
          <>
            {linkedToken ? (
              <p>Continue to accept your classroom invitation.</p>
            ) : (
              <label>
                CPU account number
                <input
                  required
                  name="studentNumber"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{7}"
                  minLength={7}
                  maxLength={7}
                  value={studentNumber}
                  onChange={(e) => setStudentNumber(e.target.value)}
                  placeholder="2020123"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  aria-describedby="cpu-number-help"
                />
                <small id="cpu-number-help">For s2020123@cpu.edu.hk, enter 2020123.</small>
              </label>
            )}
            <button className="primary" disabled={busy}>
              Continue
            </button>
          </>
        ) : needsGoogle && challenge?.required ? (
          <GoogleSignup key={challenge.nonce} challenge={challenge} selected={setCredential} />
        ) : (
          <>
            {register && challenge?.required && (
              <p>
                Choose your classroom username and password for <strong>{challenge.email}</strong>.
              </p>
            )}
            <label>
              Username
              <input
                required
                name="username"
                autoComplete="username"
                maxLength={48}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label>
              Password
              <input
                required
                name="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                type="password"
                minLength={register ? 12 : undefined}
                maxLength={128}
              />
              {register && <small>Use at least 12 characters.</small>}
            </label>
            {setupRequired && register && (
              <label>
                Owner setup code
                <input
                  required
                  name="token"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  type="password"
                />
              </label>
            )}
            <div className="auth-submit-row">
              <button className="primary" disabled={busy}>
                {register ? 'Create account' : 'Sign in'}
              </button>
              {!register && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setRecover(true)}
                >
                  Forgot password?
                </button>
              )}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="course-error">
            {error}
          </p>
        )}
      </form>
      {register && challenge && (
        <button className="text-button" disabled={busy} onClick={clearVerification}>
          Start verification again
        </button>
      )}
      {!setupRequired && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            clearVerification();
            setLinkedToken('');
            setRegister(!register);
          }}
        >
          {register ? 'Sign in with an existing account' : 'Register as Phy Team Member'}
        </button>
      )}
    </section>
  );
}
