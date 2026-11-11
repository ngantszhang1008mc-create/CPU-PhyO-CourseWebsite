// Shared by the offline compiler, upload API, and lesson reader.
export const MAX_PACKAGE_BYTES = 6 * 1024 * 1024;
export const PACKAGE_FORMAT = 'cpu-lesson-v1';

export interface GraphicElement {
  tag: string;
  attrs: Record<string, string | number>;
  children: GraphicNode[];
}
export type GraphicNode = GraphicElement | string;
export interface WidgetControl {
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  unit?: string;
  presets?: { label: string; value: number }[];
}
export interface InteractiveBlock {
  kind: 'interactive';
  title: string;
  control: WidgetControl;
  frames: GraphicNode[];
}
export type Block =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string }
  | { kind: 'image'; src: string; alt: string }
  | InteractiveBlock;

export interface Question {
  id: string;
  title: string;
  topic: string;
  difficulty: string;
  statement: Block[];
  choices?: string[];
}
export interface Solution {
  id: string;
  hints: Block[][];
  steps: Block[];
  answer: Block[];
  correct?: number;
}
export interface LessonPackage {
  format: typeof PACKAGE_FORMAT;
  id: string;
  title: string;
  questions: Question[];
  solutions: Solution[];
}

type AuthorBlock =
  Exclude<Block, InteractiveBlock> | { kind: 'interactive'; title: string; entry: string };
export interface LessonSource extends Omit<LessonPackage, 'questions' | 'solutions'> {
  questions: (Omit<Question, 'statement'> & { statement: AuthorBlock[] })[];
  solutions: (Omit<Solution, 'hints' | 'steps' | 'answer'> & {
    hints: AuthorBlock[][];
    steps: AuthorBlock[];
    answer: AuthorBlock[];
  })[];
}

function requireValue(valid: unknown, message: string): asserts valid {
  if (!valid) throw new Error(message);
}
function record(
  value: unknown,
  fields: string[],
  name: string,
): asserts value is Record<string, unknown> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    name + ' must be an object.',
  );
  requireValue(
    Object.keys(value).every((key) => fields.includes(key)),
    'Unexpected field in ' + name + '.',
  );
}
function string(value: unknown, max: number, name: string): asserts value is string {
  requireValue(
    typeof value === 'string' && value.trim().length > 0 && value.length <= max,
    'Invalid ' + name + '.',
  );
}
function list(value: unknown, min: number, max: number, name: string): asserts value is unknown[] {
  requireValue(
    Array.isArray(value) && value.length >= min && value.length <= max,
    'Invalid ' + name + ' list.',
  );
}
function slug(value: unknown): asserts value is string {
  string(value, 64, 'ID');
  requireValue(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
    'IDs must be lowercase alphanumeric slugs.',
  );
}
function onGrid(value: unknown, min: number, step: number, intervals: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const n = (value - min) / step;
  return Math.abs(n - Math.round(n)) < 1e-8 && Math.round(n) >= 0 && Math.round(n) <= intervals;
}
export function widgetFrameCount(value: unknown): number {
  record(value, ['label', 'min', 'max', 'step', 'initial', 'unit', 'presets'], 'widget control');
  string(value.label, 100, 'slider label');
  if (value.unit !== undefined) string(value.unit, 30, 'unit');
  const { min, max, step } = value;
  requireValue(
    typeof min === 'number' &&
      Number.isFinite(min) &&
      typeof max === 'number' &&
      Number.isFinite(max) &&
      typeof step === 'number' &&
      Number.isFinite(step) &&
      step > 0 &&
      max > min,
    'Invalid slider bounds.',
  );
  const intervals = Math.round((max - min) / step);
  requireValue(
    intervals >= 1 && intervals <= 200 && onGrid(max, min, step, intervals),
    'Use 2 to 201 evenly spaced states.',
  );
  requireValue(
    onGrid(value.initial, min, step, intervals),
    'Initial value must be a slider state.',
  );
  if (value.presets !== undefined) {
    list(value.presets, 0, 8, 'presets');
    for (const preset of value.presets) {
      record(preset, ['label', 'value'], 'preset');
      string(preset.label, 60, 'preset label');
      requireValue(
        onGrid(preset.value, min, step, intervals),
        'Preset value must be a slider state.',
      );
    }
  }
  return intervals + 1;
}

const graphicTags = new Set([
  'div',
  'p',
  'span',
  'strong',
  'small',
  'em',
  'svg',
  'g',
  'path',
  'line',
  'rect',
  'circle',
  'ellipse',
  'polyline',
  'polygon',
  'text',
  'tspan',
]);
const numericAttributes = new Set([
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'dx',
  'dy',
  'strokeWidth',
  'fontSize',
  'opacity',
  'fillOpacity',
  'strokeOpacity',
  'pathLength',
]);
const numbers = /^[+\-\d.eE\s,]+$/;
const colors = new Set([
  'none',
  'currentColor',
  'black',
  'white',
  'red',
  'green',
  'blue',
  'gray',
  'grey',
  'orange',
  'purple',
  'pink',
  'brown',
  'navy',
  'yellow',
  'transparent',
]);
function safeGraphicAttribute(name: string, value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'number') return Number.isFinite(value) && numericAttributes.has(name);
  if (value.length > 8000) return false;
  if (numericAttributes.has(name))
    return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?$/.test(value);
  switch (name) {
    case 'fill':
    case 'stroke':
      return colors.has(value) || /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value);
    case 'viewBox':
    case 'points':
    case 'strokeDasharray':
      return numbers.test(value);
    case 'd':
      return /^[MmLlHhVvCcSsQqTtAaZz+\-\d.eE\s,]+$/.test(value);
    case 'transform':
      return /^(?:(?:translate|scale|rotate|matrix|skewX|skewY)\([+\-\d.eE\s,]+\)\s*)+$/.test(
        value,
      );
    case 'textAnchor':
      return ['start', 'middle', 'end'].includes(value);
    case 'dominantBaseline':
      return ['auto', 'middle', 'central', 'hanging', 'alphabetic'].includes(value);
    case 'strokeLinecap':
      return ['round', 'butt', 'square'].includes(value);
    case 'strokeLinejoin':
      return ['round', 'bevel', 'miter'].includes(value);
    case 'fontWeight':
      return /^(normal|bold|[1-9]00)$/.test(value);
    case 'fontStyle':
      return ['normal', 'italic'].includes(value);
    case 'fontFamily':
      return ['serif', 'sans-serif', 'monospace', 'Georgia'].includes(value);
    case 'role':
      return value === 'img';
    case 'aria-label':
      return value.trim().length > 0 && value.length <= 250;
    default:
      return false;
  }
}
function graphic(node: unknown, depth = 0): void {
  requireValue(depth <= 24, 'Widget frame is too deeply nested.');
  if (typeof node === 'string') {
    requireValue(node.length <= 8000, 'Widget text is too long.');
    return;
  }
  record(node, ['tag', 'attrs', 'children'], 'widget element');
  requireValue(
    typeof node.tag === 'string' && graphicTags.has(node.tag),
    'Unsupported widget element.',
  );
  requireValue(
    node.attrs && typeof node.attrs === 'object' && !Array.isArray(node.attrs),
    'Invalid widget attributes.',
  );
  for (const [name, value] of Object.entries(node.attrs)) {
    requireValue(
      safeGraphicAttribute(name, value),
      'Unsupported widget attribute: ' + name.slice(0, 50),
    );
  }
  list(node.children, 0, 300, 'widget children');
  node.children.forEach((child) => graphic(child, depth + 1));
}
export function validateBlock(value: unknown): asserts value is Block {
  record(value, ['kind', 'value', 'src', 'alt', 'title', 'control', 'frames'], 'block');
  if (value.kind === 'text' || value.kind === 'math') {
    record(value, ['kind', 'value'], 'text or math block');
    string(value.value, 32000, 'text or math');
  } else if (value.kind === 'image') {
    record(value, ['kind', 'src', 'alt'], 'image');
    string(value.alt, 500, 'image description');
    string(value.src, 2 * 1024 * 1024, 'image');
    requireValue(
      /^data:image\/(?:png;base64,iVBORw0KGgo|jpeg;base64,\/9j\/)[A-Za-z0-9+/]*={0,2}$/.test(
        value.src,
      ),
      'Images must be embedded PNG or JPEG data.',
    );
  } else if (value.kind === 'interactive') {
    record(value, ['kind', 'title', 'control', 'frames'], 'widget');
    string(value.title, 160, 'widget title');
    const count = widgetFrameCount(value.control);
    list(value.frames, count, count, 'widget frames');
    value.frames.forEach((node) => graphic(node));
  } else throw new Error('Unknown lesson block.');
}
function blocks(value: unknown) {
  list(value, 1, 160, 'content blocks');
  value.forEach(validateBlock);
}
export function parseLessonPackage(value: unknown): LessonPackage {
  record(value, ['format', 'id', 'title', 'questions', 'solutions'], 'lesson');
  requireValue(value.format === PACKAGE_FORMAT, 'Unsupported lesson package version.');
  requireValue(
    new TextEncoder().encode(JSON.stringify(value)).length <= MAX_PACKAGE_BYTES,
    'Package exceeds 6 MiB.',
  );
  slug(value.id);
  string(value.title, 200, 'lesson title');
  list(value.questions, 1, 200, 'questions');
  list(value.solutions, value.questions.length, value.questions.length, 'solutions');
  const choicesById = new Map<string, number>();
  for (const q of value.questions) {
    record(q, ['id', 'title', 'topic', 'difficulty', 'statement', 'choices'], 'question');
    slug(q.id);
    requireValue(!choicesById.has(q.id), 'Duplicate question ID.');
    string(q.title, 200, 'question title');
    string(q.topic, 100, 'topic');
    string(q.difficulty, 60, 'difficulty');
    blocks(q.statement);
    if (q.choices !== undefined) {
      list(q.choices, 2, 12, 'answer choices');
      q.choices.forEach((c) => string(c, 1000, 'answer choice'));
    }
    choicesById.set(q.id, Array.isArray(q.choices) ? q.choices.length : 0);
  }
  for (const s of value.solutions) {
    record(s, ['id', 'hints', 'steps', 'answer', 'correct'], 'solution');
    slug(s.id);
    const count = choicesById.get(s.id);
    requireValue(count !== undefined, 'Solution must match exactly one question.');
    choicesById.delete(s.id);
    list(s.hints, 1, 16, 'staged hints');
    s.hints.forEach(blocks);
    blocks(s.steps);
    blocks(s.answer);
    requireValue(
      count
        ? typeof s.correct === 'number' &&
            Number.isInteger(s.correct) &&
            s.correct >= 0 &&
            s.correct < count
        : s.correct === undefined,
      'Each multiple-choice solution requires a valid zero-based correct index.',
    );
  }
  const lesson = value as unknown as LessonPackage;
  // A solutions-only release still uses the original exercise numbering.
  const solutionsById = new Map(lesson.solutions.map((solution) => [solution.id, solution]));
  return { ...lesson, solutions: lesson.questions.map(({ id }) => solutionsById.get(id)!) };
}
