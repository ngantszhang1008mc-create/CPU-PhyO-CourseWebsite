import { useState } from 'react';
import { MAX_PACKAGE_BYTES } from '../../lib/lesson-package';
import { courseApi, explain, type SetInfo } from '../../lib/classroom';

export function PackageUpload({
  sets,
  target,
  onSaved,
}: {
  sets: SetInfo[];
  target?: SetInfo;
  onSaved: () => Promise<void>;
}) {
  const [pending, setPending] = useState<{ raw: string; title: string; existing?: SetInfo }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function select(file?: File) {
    setPending(undefined);
    setMessage('');
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > MAX_PACKAGE_BYTES) throw new Error('Choose a package of at most 6 MiB.');
      const raw = await file.text();
      const pkg = JSON.parse(raw);
      if (
        pkg?.format !== 'cpu-lesson-v1' ||
        typeof pkg.id !== 'string' ||
        typeof pkg.title !== 'string'
      )
        throw new Error('Choose a compiled CPU lesson package.');
      setPending({
        raw,
        title: pkg.title,
        existing: target ?? sets.find((set) => set.id === pkg.id),
      });
    } catch (err) {
      setMessage(explain(err));
    } finally {
      setBusy(false);
    }
  }
  async function upload() {
    if (!pending || busy) return;
    setBusy(true);
    setMessage('');
    try {
      await courseApi(target ? 'sets/' + encodeURIComponent(target.id) : 'sets', {
        method: 'POST',
        body: pending.raw,
        headers: pending.existing ? { 'If-Match': '"' + pending.existing.revision + '"' } : {},
      });
      setPending(undefined);
      setMessage('Package saved privately.');
      await onSaved();
    } catch (err) {
      setMessage(explain(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <input
        type="file"
        aria-label={target ? 'Replacement package' : 'Lesson package'}
        accept=".json,.cpulesson,.phyo,application/json"
        disabled={busy}
        onChange={(e) => {
          void select(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {pending && (
        <div className="upload-confirm">
          <p>
            {pending.existing ? (
              <>
                Replace <strong>{pending.existing.title}</strong> with{' '}
                <strong>{pending.title}</strong> at the existing classroom link? The replacement
                will be private until released.
              </>
            ) : (
              <>
                Add <strong>{pending.title}</strong> as a private draft?
              </>
            )}
          </p>
          <button type="button" disabled={busy} onClick={upload}>
            {pending.existing ? 'Replace privately' : 'Upload privately'}
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function SetPackageActions({
  info,
  onReplaced,
}: {
  info: SetInfo;
  onReplaced: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await courseApi('sets/' + encodeURIComponent(info.id), {
        method: 'DELETE',
        headers: { 'If-Match': '"' + info.revision + '"' },
      });
      location.replace('/classroom/');
    } catch (err) {
      setError(explain(err));
      setBusy(false);
    }
  }
  return (
    <details className="admin-tools">
      <summary>Replace or delete problem set</summary>
      <div className="manager-grid">
        <section>
          <h3>Replace package</h3>
          <PackageUpload sets={[]} target={info} onSaved={onReplaced} />
        </section>
        <section>
          <h3>Delete problem set</h3>
          {confirm ? (
            <>
              <p>
                Permanently delete <strong>{info.title}</strong> and its questions and solutions?
              </p>
              <div className="edit-actions">
                <button type="button" className="delete-account" disabled={busy} onClick={remove}>
                  Confirm deletion
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                    setError('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button type="button" onClick={() => setConfirm(true)}>
              Delete set
            </button>
          )}
          {error && (
            <p role="alert" className="course-error">
              {error}
            </p>
          )}
        </section>
      </div>
    </details>
  );
}
