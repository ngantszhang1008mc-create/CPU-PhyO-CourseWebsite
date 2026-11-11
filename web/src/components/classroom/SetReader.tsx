import { useCallback, useEffect, useMemo, useState } from 'react';
import katex from 'katex';
import PackageWidget from '../PackageWidget';
import type { Block, LessonPackage, Question, Solution } from '../../lib/lesson-package';
import { save, useMode, useValue } from '../../lib/practice';
import type { PracticeAction } from '../../lib/activity';
import { courseApi } from '../../lib/classroom';
import { Progress } from '../PracticeControls';

function MathBlock({ tex }: { tex: string }) {
  const html = useMemo(
    () =>
      katex.renderToString(tex, {
        displayMode: true,
        trust: false,
        throwOnError: false,
        maxExpand: 500,
        maxSize: 15,
      }),
    [tex],
  );
  return <span className="equation" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="package-blocks">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'text':
            return <p key={index}>{block.value}</p>;
          case 'math':
            return <MathBlock key={index} tex={block.value} />;
          case 'image':
            return <img key={index} src={block.src} alt={block.alt} loading="lazy" />;
          case 'interactive':
            return <PackageWidget key={index} block={block} />;
        }
      })}
    </div>
  );
}

function Exercise({
  question,
  solution,
  index,
  prefix,
  track,
}: {
  question?: Question;
  solution?: Solution;
  index: number;
  prefix: string;
  track: (action: PracticeAction, value?: number) => void;
}) {
  const mode = useMode();
  const [choice, setChoice] = useState<number>();
  const [draft, setDraft] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [guideExpanded, setGuideExpanded] = useState(true);
  const [hints, setHints] = useState(0);
  const [hint, setHint] = useState<number>();
  const key = prefix + ':' + (question?.id ?? solution?.id);
  const done = useValue(key + ':done', ['yes', 'no'] as const, 'no') === 'yes';
  const guide = mode === 'guide' || !question;
  const showSolution = guide ? guideExpanded : attempted && revealed;
  function submit() {
    track('check', choice);
    setAttempted(true);
    if (question?.choices && choice === solution?.correct) save(key + ':done', 'yes');
  }
  return (
    <article className="package-question" data-mode={mode}>
      <header className="sheet-heading rail">
        <h2>
          <span className="q-number">Q{index + 1}</span>
          <span className="slash">/</span>
          {question?.title ?? 'Worked solution'}
        </h2>
        {question && (
          <div className="tags">
            <span>{question.topic}</span>
            <span>{question.difficulty}</span>
          </div>
        )}
      </header>
      {question && (
        <div className="problem-body">
          <h3 className="section-label">Problem</h3>
          <Blocks blocks={question.statement} />
          {question.choices && (
            <fieldset className="choices">
              <legend className="sr">Answer choices</legend>
              {question.choices.map((text, i) => (
                <label key={i} className={choice === i ? 'selected' : ''}>
                  <input
                    type="radio"
                    name={key}
                    checked={choice === i}
                    onChange={() => {
                      setChoice(i);
                      setAttempted(false);
                      setRevealed(false);
                    }}
                  />
                  <span className="letter">{String.fromCharCode(65 + i)}</span>
                  {text}
                </label>
              ))}
            </fieldset>
          )}
          {!question.choices && mode === 'quiz' && (
            <label className="written">
              Your answer
              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setAttempted(false);
                  setRevealed(false);
                }}
              />
            </label>
          )}
          {solution && (question.choices || mode === 'quiz') && (
            <div className="study-controls">
              <button
                disabled={question.choices ? choice === undefined : !draft.trim()}
                onClick={submit}
              >
                {question.choices ? 'Check answer' : 'Check my work'}
              </button>
              {attempted && (
                <span role="status">
                  {question.choices
                    ? choice === solution.correct
                      ? ' Correct.'
                      : ' Try again or review the solution.'
                    : ' Compare your reasoning with the solution.'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {solution && (
        <>
          <div className="hints">
            {solution.hints.map((blocks, i) => (
              <div className="hint" key={i}>
                <button
                  aria-expanded={hint === i}
                  disabled={i > hints}
                  onClick={() => {
                    if (hint !== i) track('hint', i + 1);
                    setHint(hint === i ? undefined : i);
                    setHints(Math.max(hints, i + 1));
                  }}
                >
                  ▸ Hint {i + 1}
                </button>
                {hint === i && <Blocks blocks={blocks} />}
              </div>
            ))}
          </div>
          <button
            className="solution-toggle section-label"
            disabled={!guide && !attempted}
            aria-expanded={showSolution}
            onClick={() => {
              if (!showSolution) track('solution');
              if (guide) setGuideExpanded(!guideExpanded);
              else setRevealed(!revealed);
            }}
          >
            Worked solution
          </button>
          {showSolution && (
            <div className="solution">
              <Blocks blocks={solution.steps} />
              <div className="answer">
                <strong>Final answer</strong>
                <Blocks blocks={solution.answer} />
              </div>
            </div>
          )}
        </>
      )}
      {question && !solution && (
        <p className="release-note">
          Your teacher has released the questions. Worked solutions are hidden.
        </p>
      )}
      <div className="q-foot">
        <span>{question?.id ?? solution?.id}</span>
        <button aria-pressed={done} onClick={() => {
          save(key + ':done', done ? 'no' : 'yes');
          track(done ? 'incomplete' : 'complete');
        }}>
          {done ? 'Completed' : 'Mark complete'}
        </button>
      </div>
    </article>
  );
}

export function SetReader({
  lesson,
  username,
  studentRevision,
}: {
  lesson: LessonPackage;
  username: string;
  studentRevision?: number;
}) {
  const ids = lesson.questions.length
    ? lesson.questions.map((q) => q.id)
    : lesson.solutions.map((s) => s.id);
  const [selected, setSelected] = useState(() => new URLSearchParams(location.hash.slice(1)).get('q') ?? '');
  useEffect(() => {
    const change = () => setSelected(new URLSearchParams(location.hash.slice(1)).get('q') ?? '');
    change();
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const index = Math.max(0, ids.indexOf(selected));
  const id = ids[index];
  const [activityError, setActivityError] = useState(false);
  const track = useCallback((action: PracticeAction, value?: number) => {
    if (!studentRevision) return;
    void courseApi('sets/' + lesson.id + '/activity', {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({ revision: studentRevision, username, question: id, action, value }),
    }).catch(() => setActivityError(true));
  }, [lesson.id, studentRevision, username, id]);
  useEffect(() => { track('question'); }, [track]);
  const prefix = 'class:' + username + ':' + lesson.id;
  return (
    <div className="private-worksheet">
      <aside className="set-outline">
        <h2>{lesson.title}</h2>
        {studentRevision && <small>Classroom admins can view your practice activity.</small>}
        {activityError && <p role="status">Some activity could not be recorded. Refresh to reconnect.</p>}
        <Progress ids={ids.map((i) => prefix + ':' + i)} />
        <label>
          Go to question
          <select
            value={id}
            onChange={(e) => {
              location.hash = 'q=' + e.target.value;
            }}
          >
            {ids.map((item, i) => (
              <option key={item} value={item}>
                Q{i + 1} · {lesson.questions[i]?.title ?? item}
              </option>
            ))}
          </select>
        </label>
      </aside>
      <div className="question-column">
        <Exercise
          key={id}
          index={index}
          prefix={prefix}
          track={track}
          question={lesson.questions.find((q) => q.id === id)}
          solution={lesson.solutions.find((s) => s.id === id)}
        />
        <nav className="problem-pager" aria-label="Question navigation">
          {index > 0 && <a rel="prev" href={'#q=' + ids[index - 1]}>← Previous question</a>}
          {index + 1 < ids.length && <a rel="next" href={'#q=' + ids[index + 1]}>Next question →</a>}
        </nav>
      </div>
    </div>
  );
}
