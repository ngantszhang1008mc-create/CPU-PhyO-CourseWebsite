import type { ActivityEntry } from '../src/lib/activity.ts';
import type { Question, Solution } from '../src/lib/lesson-package.ts';
import { HttpError } from './security.ts';
import { readPart, type Database } from './storage.ts';

export function indexActivityQuestions(
  db: Database,
  id: string,
  questions: Question[],
  solutions: Solution[],
) {
  const byId = new Map(solutions.map((s) => [s.id, s]));
  questions.forEach((q, i) => {
    const solution = byId.get(q.id)!;
    db.write(
      'INSERT INTO activity_questions VALUES (?,?,?,?,?,?)',
      id,
      q.id,
      i + 1,
      q.choices?.length ?? 0,
      solution.correct ?? null,
      solution.hints.length,
    );
  });
}

export function recordPractice(
  db: Database,
  username: string,
  setId: string,
  body: Record<string, unknown>,
) {
  const set = db.all<{
    title: string;
    revision: number;
    questions_visible: number;
    solutions_visible: number;
  }>('SELECT * FROM lessons WHERE id=?', setId)[0];
  if (!set || !(set.questions_visible || set.solutions_visible))
    throw new HttpError(404, 'Problem set not found.');
  if (body.revision !== set.revision) throw new HttpError(409, 'Reopen the current problem set.');
  if (typeof body.question !== 'string') throw new HttpError(400, 'Choose a question.');
  if (!db.all('SELECT 1 FROM activity_questions WHERE set_id=? LIMIT 1', setId).length) {
    // Existing uploads acquire this compact index on their first practice event.
    indexActivityQuestions(
      db,
      setId,
      readPart(db, setId, 'questions') as Question[],
      readPart(db, setId, 'solutions') as Solution[],
    );
  }
  const q = db.all<{ number: number; choices: number; correct: number | null; hints: number }>(
    'SELECT number, choices, correct, hints FROM activity_questions WHERE set_id=? AND question_id=?',
    setId,
    body.question,
  )[0];
  if (!q) throw new HttpError(400, 'Unknown question.');
  const value = body.value;
  let kind: ActivityEntry['kind'];
  let hint: number | null = null;
  switch (body.action) {
    case 'question':
    case 'complete':
    case 'incomplete':
      kind = body.action;
      break;
    case 'solution':
    case 'hint':
    case 'check':
      if (!set.solutions_visible || (body.action === 'check' && !set.questions_visible))
        throw new HttpError(403, 'This practice action is unavailable.');
      if (body.action === 'check') {
        if (
          q.choices &&
          (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= q.choices)
        )
          throw new HttpError(400, 'Choose an available answer.');
        kind = q.choices ? (value === q.correct ? 'correct' : 'incorrect') : 'written';
      } else {
        kind = body.action;
        if (kind === 'hint') {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > q.hints)
            throw new HttpError(400, 'Choose an available hint.');
          hint = value;
        }
      }
      break;
    default:
      throw new HttpError(400, 'Unknown practice action.');
  }
  db.write(
    'INSERT INTO student_activity (username,occurred,kind,title,number,hint) VALUES (?,?,?,?,?,?)',
    username,
    Date.now(),
    kind,
    set.title,
    q.number,
    hint,
  );
}

export function studentHistory(db: Database, username: string, before: string | null) {
  if (!db.all("SELECT 1 FROM users WHERE username=? AND role='student'", username).length)
    throw new HttpError(404, 'Student account not found.');
  const cursor = before === null ? Number.MAX_SAFE_INTEGER : Number(before);
  if (!Number.isSafeInteger(cursor) || cursor < 1)
    throw new HttpError(400, 'Invalid activity page.');
  const entries = db.all<ActivityEntry>(
    'SELECT id,occurred,kind,title,number,hint FROM student_activity WHERE username=? AND id<? ORDER BY id DESC LIMIT 31',
    username,
    cursor,
  );
  const page = entries.slice(0, 30);
  return { entries: page, next: entries.length > 30 ? page[29].id : null };
}
