import { useEffect, useState, type SubmitEvent } from 'react';
import { courseApi, explain } from '../../lib/classroom';
import { formatRegistrationValidity, ValidityField, validityDays } from './ValidityField';

interface PendingRegistration {
  studentNumber: string;
  email: string;
  expires: number | null;
  version: string;
}

interface GrantResult {
  email: string;
  expires: number | null;
  created: boolean;
}

function validityLabel(expires: number | null) {
  const validity = formatRegistrationValidity(expires);
  return expires === null ? validity : 'Expires ' + validity;
}

function PendingRegistrations({
  revision,
  onCancelled,
}: {
  revision: number;
  onCancelled: (studentNumber: string) => void;
}) {
  const [registrations, setRegistrations] = useState<PendingRegistration[]>();
  const [lookupInput, setLookupInput] = useState('');
  const [lookupNumber, setLookupNumber] = useState('');
  const [refreshCount, setRefreshCount] = useState(0);
  const [confirming, setConfirming] = useState<PendingRegistration>();
  const [cancelling, setCancelling] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    setRegistrations(undefined);
    const options = { signal: controller.signal };
    const request = lookupNumber
      ? courseApi<{ registration: PendingRegistration }>(
          'student-registrations/' + lookupNumber,
          options,
        ).then(({ registration }) => [registration])
      : courseApi<{ registrations: PendingRegistration[] }>('student-registrations', options).then(
          ({ registrations }) => registrations,
        );
    request.then(
      (rows) => {
        if (!controller.signal.aborted) setRegistrations(rows);
      },
      (error) => {
        if (!controller.signal.aborted) setLoadError(explain(error));
      },
    );
    return () => controller.abort();
  }, [revision, refreshCount, lookupNumber]);

  function findRegistration(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setLookupNumber(lookupInput);
    setConfirming(undefined);
    setCancelError('');
    setNotice('');
    setRefreshCount((current) => current + 1);
  }

  async function cancel(registration: PendingRegistration) {
    if (cancelling) return;
    setCancelling(true);
    setCancelError('');
    setNotice('');
    try {
      await courseApi('student-registrations/' + encodeURIComponent(registration.studentNumber), {
        method: 'DELETE',
        body: JSON.stringify({ version: registration.version }),
      });
      setRegistrations((current) =>
        current?.filter((row) => row.studentNumber !== registration.studentNumber),
      );
      setNotice('Authorization cancelled for ' + registration.email + '.');
      setLookupNumber('');
      setLookupInput('');
      onCancelled(registration.studentNumber);
    } catch (err) {
      setCancelError(explain(err));
    } finally {
      setConfirming(undefined);
      setCancelling(false);
      setRefreshCount((current) => current + 1);
    }
  }

  return (
    <div className="account-directory">
      <form onSubmit={findRegistration}>
        <label>
          Find by CPU account number
          <input
            name="lookupStudentNumber"
            value={lookupInput}
            onChange={(event) => setLookupInput(event.target.value)}
            inputMode="numeric"
            pattern="[0-9]{7}"
            minLength={7}
            maxLength={7}
            required
            autoComplete="off"
            disabled={cancelling}
          />
        </label>
        <div className="account-actions">
          <button disabled={cancelling}>Find registration</button>
          <button
            type="button"
            disabled={cancelling}
            onClick={() => {
              setLookupNumber('');
              setLookupInput('');
              setConfirming(undefined);
              setCancelError('');
              setNotice('');
              setRefreshCount((current) => current + 1);
            }}
          >
            {lookupNumber ? 'Show all registrations' : 'Refresh list'}
          </button>
        </div>
      </form>
      {loadError && (
        <p className="course-error" role="alert">
          {loadError}
        </p>
      )}
      {cancelError && (
        <p className="course-error" role="alert">
          {cancelError}
        </p>
      )}
      <output aria-live="polite">{notice}</output>
      {!registrations && !loadError && <p role="status">Loading registrations…</p>}
      {registrations?.length === 0 && <p>No pending student registrations.</p>}
      {registrations && registrations.length > 0 && (
        <ul aria-label="Pending student registrations">
          {registrations.map((row) => (
            <li key={row.studentNumber} className="account-row">
              <strong>{row.email}</strong>
              <p>{validityLabel(row.expires)}</p>
              {confirming?.studentNumber === row.studentNumber &&
              confirming.version === row.version ? (
                <>
                  <p>Cancel signup authorization for {row.studentNumber}?</p>
                  <div className="account-actions">
                    <button
                      type="button"
                      className="delete-account"
                      disabled={cancelling}
                      onClick={() => void cancel(row)}
                    >
                      Confirm cancellation
                    </button>
                    <button
                      type="button"
                      disabled={cancelling}
                      onClick={() => setConfirming(undefined)}
                    >
                      Keep authorization
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  disabled={cancelling}
                  aria-label={'Cancel authorization for ' + row.email}
                  onClick={() => {
                    setCancelError('');
                    setNotice('');
                    setConfirming(row);
                  }}
                >
                  Cancel authorization
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QuickRegistration({
  revision,
  onAuthorized,
  onCancelled,
}: {
  revision: number;
  onAuthorized: () => void;
  onCancelled?: (studentNumber: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  async function allowRegistration(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const studentNumber = fields.get('studentNumber');
    setBusy(true);
    setConfirmation('');
    setError('');
    try {
      const result = await courseApi<GrantResult>('student-registrations', {
        method: 'POST',
        body: JSON.stringify({
          studentNumber,
          validityDays: validityDays(fields),
        }),
      });
      const status = result.created ? 'Registration allowed' : 'Registration already allowed';
      setConfirmation(`${status} for ${result.email}. ${validityLabel(result.expires)}.`);
      onAuthorized();
      const accountInput = form.elements.namedItem('studentNumber');
      if (accountInput instanceof HTMLInputElement) accountInput.value = '';
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 id="quick-registration-title">Quick student registration</h3>
      <form aria-labelledby="quick-registration-title" onSubmit={allowRegistration}>
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
            placeholder="2020123"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-describedby="quick-registration-help"
          />
          <small id="quick-registration-help">
            Enter the seven digits from the student’s school email to allow one signup.
          </small>
        </label>
        <ValidityField disabled={busy} />
        <button className="primary" disabled={busy}>
          Allow registration
        </button>
        {error && (
          <p className="course-error" role="alert">
            {error}
          </p>
        )}
        <output aria-live="polite">{confirmation}</output>
      </form>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>Pending student registrations</summary>
        {open && (
          <PendingRegistrations
            revision={revision}
            onCancelled={(studentNumber) => {
              setConfirmation('');
              onCancelled?.(studentNumber);
            }}
          />
        )}
      </details>
    </section>
  );
}
