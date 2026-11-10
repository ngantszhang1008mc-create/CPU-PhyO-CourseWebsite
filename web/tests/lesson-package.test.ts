import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseLessonPackage, type LessonPackage } from '../src/lib/lesson-package.ts';
import { packLesson } from '../tools/pack-lesson.ts';

const text = { kind: 'text', value: 'A sample prompt.' } as const;
function example(): LessonPackage {
  return {
    format: 'cpu-lesson-v1',
    id: 'test-set',
    title: 'Demo set',
    questions: [
      {
        id: 'q1',
        title: 'A measurement',
        topic: 'Units',
        difficulty: 'Foundation',
        statement: [text],
        choices: ['a', 'b'],
      },
    ],
    solutions: [{ id: 'q1', hints: [[text]], steps: [text], answer: [text], correct: 0 }],
  };
}

test('questions and answers are matched by stable ID with private keys only in solutions', () => {
  assert.equal(parseLessonPackage(example()).id, 'test-set');
  const file = example();
  assert.throws(() =>
    parseLessonPackage({ ...file, questions: [{ ...file.questions[0], correct: 0 }] }),
  );
  assert.throws(() =>
    parseLessonPackage({ ...file, solutions: [{ ...file.solutions[0], correct: 2 }] }),
  );
  assert.throws(() =>
    parseLessonPackage({ ...file, solutions: [{ ...file.solutions[0], id: 'wrong' }] }),
  );
  assert.throws(() => parseLessonPackage({ ...file, questions: [], solutions: [] }));
});

test('solutions-only releases retain question order when author solutions are reordered', () => {
  const file = example();
  file.questions.push({ ...file.questions[0], id: 'q2' });
  file.solutions.unshift({ ...file.solutions[0], id: 'q2' });
  assert.deepEqual(parseLessonPackage(file).solutions.map(s => s.id), ['q1', 'q2']);
});

test('widgets reject dynamic code, event handlers, foreign objects and resource URLs', () => {
  const control = { label: 'Input', min: 0, max: 1, step: 1, initial: 0 };
  for (const node of [
    { tag: 'script', attrs: {}, children: [] },
    { tag: 'svg', attrs: { onLoad: 'doSomething()' }, children: [] },
    { tag: 'foreignObject', attrs: {}, children: [] },
    { tag: 'path', attrs: { fill: 'url(https://example.com/image)' }, children: [] },
    { tag: 'img', attrs: { src: 'https://example.com' }, children: [] },
  ]) {
    const file = example();
    assert.throws(() =>
      parseLessonPackage({
        ...file,
        questions: [
          {
            ...file.questions[0],
            statement: [{ kind: 'interactive', title: 'Bad', control, frames: [node, node] }],
          },
        ],
      }),
    );
  }
});

test('local TS imports and React TSX views compile into portable data with no executable source', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'cpu-lesson-test-'));
  try {
    await writeFile(
      join(temp, 'data.ts'),
      'export const data = ' + JSON.stringify(example()) + ';',
    );
    await writeFile(
      join(temp, 'widget.tsx'),
      `export const control={label:'Length',min:0,max:2,step:1,initial:1,unit:'m'};
      export default function Diagram({value}:{value:number}) {return <svg viewBox="0 0 3 3"><circle cx={value} cy={1} r={1} fill="#347"/><text x={0} y={2}>{value}</text></svg>;}`,
    );
    await writeFile(
      join(temp, 'lesson.ts'),
      `import {data} from './data.ts';
      data.solutions[0].steps.push({kind:'interactive',title:'Diagram',entry:'./widget.tsx'});export default data;`,
    );
    const output = join(temp, 'lesson.cpu.json');
    await packLesson(join(temp, 'lesson.ts'), output);
    const json = await readFile(output, 'utf8');
    const parsed = parseLessonPackage(JSON.parse(json));
    const widget = parsed.solutions[0].steps[1];
    assert.equal(widget.kind, 'interactive');
    assert.equal(widget.frames.length, 3);
    assert.doesNotMatch(json, /Diagram\(|widget\.tsx|export default/);
    assert.deepEqual(widget.frames[2], {
      tag: 'svg',
      attrs: { viewBox: '0 0 3 3' },
      children: [
        { tag: 'circle', attrs: { cx: 2, cy: 1, r: 1, fill: '#347' }, children: [] },
        { tag: 'text', attrs: { x: 0, y: 2 }, children: ['2'] },
      ],
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
