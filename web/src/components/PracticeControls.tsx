import { save, useCompleted, useMode } from '../lib/practice';

export function ModeBar() {
  const mode = useMode();
  return (
    <div className="mode-switch" role="group" aria-label="Study mode">
      <button aria-pressed={mode === 'guide'} onClick={() => save('mode', 'guide')}>
        Solved Guide
      </button>
      <button aria-pressed={mode === 'quiz'} onClick={() => save('mode', 'quiz')}>
        Student Quiz
      </button>
    </div>
  );
}

export function Progress({ ids }: { ids: string[] }) {
  const done = useCompleted(ids);
  return (
    <div className="progress">
      <span className="sr">Practice progress</span>
      <b>
        {done} / {ids.length}
      </b>
      <progress value={done} max={ids.length} aria-label="Problems completed" />
    </div>
  );
}
