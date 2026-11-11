import { useState } from 'react';
import { courseApi, explain } from '../../lib/classroom';
import { activityLabels, type ActivityEntry } from '../../lib/activity';

interface Page {
  entries: ActivityEntry[];
  next: number | null;
}

export function StudentActivity({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(cursor?: number) {
    setBusy(true);
    setError('');
    try {
      const path = 'accounts/' + encodeURIComponent(username) + '/activity';
      const page = await courseApi<Page>(path + (cursor ? '?before=' + cursor : ''));
      setEntries((current) => (cursor ? [...current, ...page.entries] : page.entries));
      setNext(page.next);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="student-activity">
      <button
        type="button"
        aria-expanded={open}
        disabled={busy && !open}
        aria-label={(open ? 'Hide activity for ' : 'View activity for ') + username}
        onClick={() => {
          if (!open) void load();
          setOpen(!open);
        }}
      >
        {open ? 'Hide activity' : 'View activity'}
      </button>
      {open && (
        <div>
          <h3>Activity for {username}</h3>
          <button type="button" disabled={busy} onClick={() => void load()}>
            Refresh activity
          </button>
          {error && (
            <p role="alert" className="course-error">
              {error}
            </p>
          )}
          {busy && <p role="status">Loading activity…</p>}
          {!busy && !error && entries.length === 0 && <p>No activity recorded yet.</p>}
          <ol>
            {entries.map((entry) => (
              <li key={entry.id}>
                <time dateTime={new Date(entry.occurred).toISOString()}>
                  {new Date(entry.occurred).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
                <span>
                  {activityLabels[entry.kind]}
                  {entry.hint ? ' ' + entry.hint : ''}
                  {entry.title && <> · {entry.title}</>}
                  {entry.number && <> · Q{entry.number}</>}
                </span>
              </li>
            ))}
          </ol>
          {next && (
            <button type="button" disabled={busy} onClick={() => void load(next)}>
              Show older activity
            </button>
          )}
        </div>
      )}
    </section>
  );
}
