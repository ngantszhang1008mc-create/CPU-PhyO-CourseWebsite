import { useRef, useState, type SubmitEvent } from 'react';
import { courseApi, explain, type SetInfo } from '../../lib/classroom';
import {
  parseLessonPackage,
  validateBlock,
  type Block,
  type LessonPackage,
  type Question,
  type Solution,
} from '../../lib/lesson-package';

function replaced<T>(items: T[], index: number, value: T) {
  return items.map((item, i) => (i === index ? value : item));
}

function EditGraphic({
  block,
  update,
}: {
  block: Extract<Block, { kind: 'image' | 'interactive' }>;
  update: (value: Block) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState('');
  const [file, setFile] = useState<File>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const label = block.kind === 'image' ? 'Replace image' : 'Edit interactive diagram';
  async function apply() {
    setBusy(true);
    setError('');
    try {
      let value: unknown;
      if (block.kind === 'interactive') {
        value = JSON.parse(source);
      } else {
        if (!file || file.size > 1.5 * 1024 * 1024)
          throw new Error('Choose a PNG or JPEG smaller than 1.5 MiB.');
        const src = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Could not read the image.'));
          reader.readAsDataURL(file);
        });
        value = { ...block, src };
      }
      validateBlock(value);
      if (value.kind !== block.kind) throw new Error('Keep the same type of diagram.');
      update(value);
      dialog.current?.close();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError('');
          setFile(undefined);
          setSource(block.kind === 'interactive' ? JSON.stringify(block, null, 2) : '');
          dialog.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        aria-label={label}
        onClose={() => setSource('')}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <h3>{label}</h3>
        {block.kind === 'image' ? (
          <label>
            PNG or JPEG
            <input
              type="file"
              accept="image/png,image/jpeg"
              onClick={(e) => {
                e.currentTarget.value = '';
              }}
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
        ) : (
          <label>
            Diagram data (JSON)
            <textarea
              rows={12}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              spellCheck={false}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="course-error">
            {error}
          </p>
        )}
        <div className="edit-actions">
          <button
            type="button"
            disabled={busy || (block.kind === 'image' && !file)}
            onClick={apply}
          >
            Apply
          </button>
          <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  );
}

function ContentFields({
  title,
  blocks,
  change,
}: {
  title: string;
  blocks: Block[];
  change: (blocks: Block[]) => void;
}) {
  return (
    <fieldset className="edit-blocks">
      <legend>{title}</legend>
      {blocks.map((block, index) => {
        const update = (value: Block) => change(replaced(blocks, index, value));
        return (
          <div className="edit-block" key={index}>
            {block.kind === 'interactive' ? (
              <label>
                Interactive diagram title
                <input
                  value={block.title}
                  maxLength={160}
                  onChange={(e) => update({ ...block, title: e.target.value })}
                />
              </label>
            ) : block.kind === 'image' ? (
              <label>
                Image description
                <img src={block.src} alt={block.alt} loading="lazy" />
                <input
                  value={block.alt}
                  maxLength={500}
                  onChange={(e) => update({ ...block, alt: e.target.value })}
                />
              </label>
            ) : (
              <label>
                {block.kind === 'math' ? 'Equation (LaTeX)' : 'Text'}
                <textarea
                  rows={block.kind === 'math' ? 2 : 3}
                  value={block.value}
                  maxLength={32000}
                  onChange={(e) => update({ ...block, value: e.target.value })}
                />
              </label>
            )}
            {(block.kind === 'interactive' || block.kind === 'image') && (
              <EditGraphic block={block} update={update} />
            )}
            {blocks.length > 1 && (
              <button
                type="button"
                className="text-button"
                aria-label={'Remove block ' + (index + 1) + ' from ' + title}
                onClick={() => change(blocks.filter((_, i) => i !== index))}
              >
                Remove block
              </button>
            )}
          </div>
        );
      })}
      <div className="edit-actions">
        <button type="button" onClick={() => change([...blocks, { kind: 'text', value: '' }])}>
          Add text
        </button>
        <button type="button" onClick={() => change([...blocks, { kind: 'math', value: '' }])}>
          Add equation
        </button>
      </div>
    </fieldset>
  );
}

export function SetEditor({
  lesson,
  revision,
  onSave,
  onCancel,
}: {
  lesson: LessonPackage;
  revision: number;
  onSave: (set: SetInfo, lesson: LessonPackage, questionId: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(lesson);
  const [baseRevision] = useState(revision);
  const [index, setIndex] = useState(() => {
    const id = new URLSearchParams(location.hash.slice(1)).get('q');
    return Math.max(
      0,
      lesson.questions.findIndex((q) => q.id === id),
    );
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const question = draft.questions[index];
  const solutionIndex = draft.solutions.findIndex((s) => s.id === question.id);
  const solution = draft.solutions[solutionIndex];

  function editQuestion(fields: Partial<Question>) {
    setDraft({ ...draft, questions: replaced(draft.questions, index, { ...question, ...fields }) });
  }
  function editSolution(fields: Partial<Solution>) {
    setDraft({
      ...draft,
      solutions: replaced(draft.solutions, solutionIndex, { ...solution, ...fields }),
    });
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const pkg = parseLessonPackage(draft);
      const { set } = await courseApi<{ set: SetInfo }>('sets/' + encodeURIComponent(pkg.id), {
        method: 'PUT',
        headers: { 'If-Match': '"' + baseRevision + '"' },
        body: JSON.stringify(pkg),
      });
      onSave(set, pkg, question.id);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="set-editor" onSubmit={submit}>
      <fieldset disabled={busy} className="edit-sheet">
        <legend>Modify problem set</legend>
        <label>
          Problem set title
          <input
            required
            maxLength={200}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          Question to edit
          <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
            {draft.questions.map((q, i) => (
              <option key={q.id} value={i}>
                Q{i + 1} · {q.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Question title
          <input
            required
            maxLength={200}
            value={question.title}
            onChange={(e) => editQuestion({ title: e.target.value })}
          />
        </label>
        <div className="edit-tags">
          <label>
            Topic
            <input
              maxLength={100}
              value={question.topic}
              onChange={(e) => editQuestion({ topic: e.target.value })}
            />
          </label>
          <label>
            Difficulty
            <input
              maxLength={60}
              value={question.difficulty}
              onChange={(e) => editQuestion({ difficulty: e.target.value })}
            />
          </label>
        </div>
        <ContentFields
          title="Problem"
          blocks={question.statement}
          change={(statement) => editQuestion({ statement })}
        />
        {question.choices && (
          <fieldset className="edit-blocks">
            <legend>Answer choices</legend>
            {question.choices.map((choice, i) => (
              <label key={i}>
                Choice {String.fromCharCode(65 + i)}
                <input
                  value={choice}
                  required
                  maxLength={1000}
                  onChange={(e) =>
                    editQuestion({ choices: replaced(question.choices!, i, e.target.value) })
                  }
                />
              </label>
            ))}
            <label>
              Correct answer
              <select
                value={solution.correct}
                onChange={(e) => editSolution({ correct: Number(e.target.value) })}
              >
                {question.choices.map((_, i) => (
                  <option key={i} value={i}>
                    {String.fromCharCode(65 + i)}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        )}
        {solution.hints.map((hint, i) => (
          <ContentFields
            key={i}
            title={'Hint ' + (i + 1)}
            blocks={hint}
            change={(blocks) => editSolution({ hints: replaced(solution.hints, i, blocks) })}
          />
        ))}
        <ContentFields
          title="Worked solution"
          blocks={solution.steps}
          change={(steps) => editSolution({ steps })}
        />
        <ContentFields
          title="Final answer"
          blocks={solution.answer}
          change={(answer) => editSolution({ answer })}
        />
        <div className="edit-footer">
          {error && (
            <p className="course-error" role="alert">
              {error}
            </p>
          )}
          <div className="edit-actions">
            <button type="submit" className="primary" disabled={draft === lesson}>
              Save changes
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
