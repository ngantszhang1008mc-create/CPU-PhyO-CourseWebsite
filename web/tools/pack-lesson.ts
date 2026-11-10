// Run only on trusted, locally reviewed authoring code.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Fragment, isValidElement, type ReactNode } from 'react';
import ts from 'typescript';
import {
  parseLessonPackage,
  widgetFrameCount,
  type Block,
  type GraphicNode,
  type LessonSource,
  type WidgetControl,
} from '../src/lib/lesson-package.ts';

function inside(folder: string, path: string) {
  const rel = relative(folder, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
async function asset(folder: string, filename: string) {
  if (isAbsolute(filename)) throw new Error('Package assets must use paths relative to the entry.');
  const path = await realpath(resolve(folder, filename));
  if (!inside(folder, path)) throw new Error('Package asset is outside the authoring directory.');
  return path;
}

function frameNodes(jsx: ReactNode, depth = 0): GraphicNode[] {
  if (depth > 24) throw new Error('Widget JSX nesting is too deep.');
  if (jsx === null || jsx === undefined || typeof jsx === 'boolean') return [];
  if (typeof jsx === 'string' || typeof jsx === 'number') return [String(jsx)];
  if (Array.isArray(jsx)) return jsx.flatMap((node) => frameNodes(node, depth + 1));
  if (!isValidElement<{ children?: ReactNode }>(jsx))
    throw new Error('A widget must return plain synchronous JSX.');
  const { children, ...attrs } = jsx.props;
  if (jsx.type === Fragment) return frameNodes(children, depth + 1);
  if (typeof jsx.type !== 'string')
    throw new Error('Use native HTML/SVG elements in a widget frame.');
  return [{ tag: jsx.type, attrs, children: frameNodes(children, depth + 1) }];
}

async function compileBlock(
  block: LessonSource['questions'][number]['statement'][number],
  folder: string,
): Promise<Block> {
  if (block.kind === 'image' && !block.src.startsWith('data:')) {
    const path = await asset(folder, block.src);
    const suffix = extname(path).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(suffix))
      throw new Error('Use PNG or JPEG for question figures.');
    if ((await lstat(path)).size > 1.5 * 1024 * 1024) throw new Error('Image is too large.');
    const mime = suffix === '.png' ? 'png' : 'jpeg';
    return {
      ...block,
      src: 'data:image/' + mime + ';base64,' + (await readFile(path)).toString('base64'),
    };
  }
  if (block.kind !== 'interactive') return block;
  const module = await import(pathToFileURL(await asset(folder, block.entry)).href);
  const control: WidgetControl = module.control;
  const length = widgetFrameCount(control);
  if (typeof module.default !== 'function')
    throw new Error('A widget must export a default React view function.');
  const frames = Array.from({ length }, (_, i) => {
    const value = Number((control.min + control.step * i).toPrecision(12));
    const nodes = frameNodes(module.default({ value }));
    return nodes.length === 1 ? nodes[0] : { tag: 'div', attrs: {}, children: nodes };
  });
  return { kind: 'interactive', title: block.title, control, frames };
}

export async function packLesson(input: string, destination: string) {
  const entry = await realpath(input);
  const folder = dirname(entry);
  const output = resolve(await realpath(dirname(destination)), destination.split(sep).at(-1)!);
  if (!output.endsWith('.cpu.json'))
    throw new Error('Choose an output filename ending in .cpu.json.');
  const web = fileURLToPath(new URL('../', import.meta.url));
  if (inside(web, output))
    throw new Error('Save the upload outside web/. Private lessons belong in private-drafts/.');

  // Compile only author modules. React's automatic JSX runtime resolves from the
  // website so a private source directory does not need its own node_modules.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'].includes(specifier)) {
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const filename = fileURLToPath(url);
      if (!inside(folder, filename) || !/\.tsx?$/.test(filename)) return nextLoad(url, context);
      const result = ts.transpileModule(readFileSync(filename, 'utf8'), {
        fileName: filename,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
      });
      if (result.diagnostics?.length)
        throw new Error(ts.flattenDiagnosticMessageText(result.diagnostics[0].messageText, '\n'));
      return { format: 'module', shortCircuit: true, source: result.outputText };
    },
  });
  try {
    const source: LessonSource = (await import(pathToFileURL(entry).href)).default;
    const compile = (blocks: LessonSource['questions'][number]['statement']) =>
      Promise.all(blocks.map((b) => compileBlock(b, folder)));
    const questions = await Promise.all(
      source.questions.map(async (q) => ({ ...q, statement: await compile(q.statement) })),
    );
    const solutions = await Promise.all(
      source.solutions.map(async (s) => ({
        ...s,
        hints: await Promise.all(s.hints.map(compile)),
        steps: await compile(s.steps),
        answer: await compile(s.answer),
      })),
    );
    const compiled = parseLessonPackage({ ...source, questions, solutions });
    const temp = output + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, JSON.stringify(compiled), { mode: 0o600, flag: 'wx' });
      await rename(temp, output);
    } finally {
      await rm(temp, { force: true });
    }
    return { id: compiled.id, questions: questions.length, output };
  } finally {
    hooks.deregister();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4)
      throw new Error(
        'Usage: node --experimental-strip-types tools/pack-lesson.ts ENTRY.ts OUTPUT.cpu.json',
      );
    const { id, questions, output } = await packLesson(process.argv[2], process.argv[3]);
    console.log(`Packed ${id} (${questions} questions): ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to pack lesson.');
    process.exitCode = 1;
  }
}
