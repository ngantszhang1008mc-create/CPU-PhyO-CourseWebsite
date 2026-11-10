import { useEffect, useRef, useState } from 'react';
import type { LessonPackage } from '../../lib/lesson-package';
import { courseApi, explain, roleLabel, type Session, type SetInfo } from '../../lib/classroom';
import { Accounts } from './Accounts';
import { PasswordRecovery } from './PasswordRecovery';
import { Password } from './Password';
import { Login } from './Login';
import { Management, Visibility } from './Management';
import { ModeBar } from '../PracticeControls';
import { SetReader } from './SetReader';

interface Loaded {
  session: Session;
  sets: SetInfo[];
  detail?: { set: SetInfo; package: LessonPackage };
}

export default function Classroom() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [invite, setInvite] = useState('');
  const request = useRef(0);

  async function refresh() {
    const sequence = ++request.current;
    setError('');
    try {
      const session = await courseApi<Session>('session');
      const id = new URLSearchParams(location.search).get('set');
      let sets: SetInfo[] = [];
      let detail: Loaded['detail'];
      if (session.user) {
        if (id) detail = await courseApi('sets/' + encodeURIComponent(id));
        else sets = (await courseApi<{ sets: SetInfo[] }>('sets')).sets;
      }
      if (request.current === sequence) setLoaded({ session, sets, detail });
    } catch (err) {
      if (request.current === sequence) {
        setLoaded(undefined);
        setError(explain(err));
      }
    }
  }

  useEffect(() => {
    const code = new URLSearchParams(location.hash.slice(1)).get('invite');
    const reset = new URLSearchParams(location.hash.slice(1)).get('reset');
    if (reset) {
      setResetToken(reset);
      history.replaceState(null, '', location.pathname + location.search);
    } else if (code) {
      setInvite(code);
      history.replaceState(null, '', location.pathname + location.search);
    }
    void refresh();
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void refresh();
    };
    window.addEventListener('pageshow', restored);
    return () => {
      request.current++;
      window.removeEventListener('pageshow', restored);
    };
  }, []);

  async function logout() {
    setBusy(true);
    try {
      await courseApi('logout', { method: 'POST', body: '{}' });
      location.replace('/classroom/');
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  if (resetToken)
    return (
      <div className="course-portal">
        <PasswordRecovery token={resetToken} close={() => location.replace('/classroom/')} />
      </div>
    );
  if (!loaded)
    return (
      <section className="course-portal">
        <p role="status">{error || 'Opening classroom…'}</p>
        {error && (
          <div>
            <button onClick={() => void refresh()}>Retry</button>{' '}
            <a href="/classroom/">Back to classroom</a>
          </div>
        )}
      </section>
    );
  const user = loaded.session.user;
  if (!user)
    return (
      <div className="course-portal">
        <Login
          setupRequired={loaded.session.setupRequired}
          invite={invite}
          onSuccess={() => void refresh()}
        />
      </div>
    );
  const { detail, sets } = loaded;
  return (
    <section className="course-portal">
      <header className="portal-top rail">
        <h1>{detail ? <a href="/classroom/">← Classroom</a> : 'Classroom'}</h1>
        <div>
          {detail && <ModeBar />}
          <span>
            {user.username} · {roleLabel(user)}
          </span>
          <button onClick={logout} disabled={busy}>
            Sign out
          </button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {detail ? (
        <>
          {user.role === 'admin' && (
            <Visibility key={detail.set.revision} info={detail.set} updated={refresh} />
          )}
          <SetReader lesson={detail.package} username={user.username} />
        </>
      ) : (
        <>
          {user.role === 'admin' && <Accounts viewer={user} />}
          {user.role === 'admin' && (
            <Management isPrimary={user.isPrimary} sets={sets} refresh={refresh} />
          )}
          <h2 className="section-label">Problem sets</h2>
          <div className="set-list">
            {sets.map((s) => (
              <a key={s.id} href={'/classroom/?set=' + encodeURIComponent(s.id)}>
                <strong>{s.title}</strong>
                <span>
                  {s.questionsVisible && s.solutionsVisible
                    ? 'Questions and solutions released'
                    : s.questionsVisible
                      ? 'Questions released'
                      : s.solutionsVisible
                        ? 'Solutions released'
                        : 'Private draft'}{' '}
                  →
                </span>
              </a>
            ))}
          </div>
          {!sets.length && (
            <p>
              {user.role === 'admin'
                ? 'Upload a package to add your first problem set.'
                : 'Your teacher has not released a problem set yet.'}
            </p>
          )}
        </>
      )}
      {!detail && <Password />}
    </section>
  );
}
