# Author a CPU Physics Olympiad problem set

Deliver a reviewed React/TypeScript source package and a compiled `.cpu.json` file. The administrator uploads the compiled file in Classroom. It contains the complete question set, worked solutions, images and interactive states. The website serves its own controls. Authors can create original diagrams with React and TypeScript.

## Set up the source

Work from the course website checkout with Node 22.23.4 or later. Install the website's locked dependencies if they are missing.

```sh
cd web
npm ci --ignore-scripts
cd ..
```

Create a private working directory such as `private-drafts/speed-lab/`. Put the package entry in `lesson.ts`, React views in `.tsx` files, and figures inside the same directory. Keep the source archive, teacher notes, and compiled private upload out of Git and the public site. Build only from materials the teacher has authorized for that set. The compiler executes author code on the local machine, so the operator should review source and imports before building.

## Write the package

Default-export a lesson object. The `LessonSource` interface lives in `web/src/lib/lesson-package.ts`. For a source two levels beneath the repository root, the type-only import below also gives the editor field validation. Keep permanent lowercase alphanumeric IDs, using hyphens between words. Preserve question order, choices, units, figures and subpart labels. Put the same ID on the question and its solution.

```ts
// private-drafts/speed-lab/lesson.ts
import type { LessonSource } from '../../web/src/lib/lesson-package.ts';

export default {
  format: 'cpu-lesson-v1',
  id: 'speed-lab',
  title: 'Speed and stopping distance',
  questions: [{
    id: 'cart-01',
    title: 'Braking on level ground',
    topic: 'Kinematics',
    difficulty: 'Foundation',
    statement: [
      { kind: 'text', value: 'A cart moving at 4 m/s brakes uniformly at 2 m/s² until it stops. How far does it travel?' },
    ],
    choices: ['2 m', '4 m', '8 m'],
  }],
  solutions: [{
    id: 'cart-01',
    hints: [
      [{ kind: 'text', value: 'What area on a speed–time graph represents distance?' }],
      [{ kind: 'text', value: 'Calculate the stopping time first.' }],
    ],
    steps: [
      { kind: 'text', value: 'The stopping time is 4/2 = 2 s. The speed–time graph is a triangle.' },
      { kind: 'math', value: String.raw`d=\tfrac12(2\,\mathrm{s})(4\,\mathrm{m/s})` },
      { kind: 'interactive', title: 'Compare initial speeds', entry: './Braking.tsx' },
    ],
    answer: [{ kind: 'math', value: String.raw`d=4\,\mathrm{m}` }],
    correct: 1,
  }],
} satisfies LessonSource;
```

For a written-response problem, omit both `choices` and `correct`. For multiple choice, supply 2–12 choices on the question and a zero-based `correct` index on the solution. Each set supports 1–200 questions. Give each solution 1–16 staged hints, a derivation in `steps`, and an explicit `answer`. The application uses these fields for quiz feedback and guided solutions.

For every HKPhO question and subpart, give a complete solution that students can follow without calculus. Carry that method through the staged hints, worked steps and interactive explanations. For example, find a quadratic minimum by completing the square, or find displacement from a piecewise-linear velocity graph by adding signed triangle and rectangle areas. For a numerical multiple-choice optimum, justify why the nearest option wins even after rounding.

## Use the content blocks

| Kind | Author fields | Example use |
| --- | --- | --- |
| `text` | `value` | A paragraph explaining an assumption, a subpart, or a step |
| `math` | `value` | KaTeX expression, e.g. `String.raw\`v^2=u^2+2as\`` |
| `image` | `src`, `alt` | `{ kind: 'image', src: './figures/track.png', alt: 'Track rising 2 m between gates A and B' }` |
| `interactive` | `entry`, `title` | A pure TSX view that explores a physical parameter |

Use separate blocks for paragraphs and display equations. Text and choice strings are plain text. Use Unicode in short choice labels. Supply PNG or JPEG images up to approximately 1.5 MiB each and leave room for base64 expansion. Image and widget paths are relative to the directory containing `lesson.ts`, including when the block is defined in another module. Use explicit extensions for TypeScript imports, such as `./questions.ts`. The finished file must fit within 6 MiB.

When a word-only question describes a physical scene, add a setup diagram to a staged hint and a worked diagram or interactive view to the solution. In the hint, label the given quantities, directions and unknowns. In the solution, show the relationship used to reach the answer. Supply alt text for both, label any enlarged or schematic distances, and check the labels at phone width. Keep these visuals in `hints` and `steps` so students can attempt the original prompt first.

Questions, choices, and everything embedded in a question diagram travel together when questions are released. Keep answer keys, labelled solution figures, worked examples that reveal the answer, and solution-dependent widgets in the solution section.

## Write an interactive React view

Export a numeric slider configuration and a default function taking `{ value: number }`. All physics and coordinates should derive from that value. The compiler evaluates the pure view for each state and validates its text and drawing primitives. Students can drag the slider, use cursor keys, select presets and reset the view. The upload contains the rendered states; executable author JavaScript stays on the local machine.

```tsx
// private-drafts/speed-lab/Braking.tsx
export const control = {
  label: 'Initial speed', unit: 'm/s', min: 0, max: 8, step: 0.5, initial: 4,
  presets: [{ label: 'Double the given speed', value: 8 }],
};

export default function Braking({ value }: { value: number }) {
  const deceleration = 2;
  const stoppingTime = value / deceleration;
  const stoppingDistance = value * stoppingTime / 2;
  return <div>
    <svg viewBox="0 0 260 134" role="img" aria-label="Speed falls linearly to zero during braking">
      <polygon points={`26,108 26,${108 - 10 * value} ${26 + 42 * stoppingTime},108`} fill="#bdcdaa" />
      <path d="M26 15V108H215" fill="none" stroke="#30352b" />
      <text x={32} y={18} fontSize={11}>Speed (m/s)</text>
      <text x={160} y={126} fontSize={11}>Time (s)</text>
    </svg>
    <p>Stop after {stoppingTime} s. Distance = {stoppingDistance} m.</p>
  </div>;
}
```

Choose 2–201 evenly spaced values. Both endpoints, the initial value and every preset must lie on the grid. Use up to eight presets. Reset is built in. Use arithmetic, typed helper functions, loops or maps to produce native JSX elements. Avoid hooks, event handlers, CSS imports and network dependencies. Every state should fit a narrow screen. Keep the key numeric result readable without inspecting the drawing.

Supported HTML elements are `div`, `p`, `span`, `strong`, `small` and `em`. Supported SVG elements are `svg`, `g`, `path`, `line`, `rect`, `circle`, `ellipse`, `polyline`, `polygon`, `text` and `tspan`. Use React attribute names such as `viewBox`, `strokeWidth`, `textAnchor` and `fontSize`. Numeric coordinates, hex colors, plain strokes, path data, labels and simple transforms are supported. The exact allowlist is in `web/src/lib/lesson-package.ts`. Scripts, generic styles, resource URLs, linked images, arbitrary HTML and event attributes are rejected.

## Build and hand off

Run from the repository root:

```sh
node --experimental-strip-types web/tools/pack-lesson.ts \
  private-drafts/speed-lab/lesson.ts \
  private-drafts/speed-lab/speed-lab.cpu.json
```

The compiler resolves local figures, builds the interactive frames and checks the matching question and solution IDs. A successful build prints the question count and output path. Compare that count and every subpart against the authorized source. Check option letters, units, sign conventions, limiting cases and rounded numerical values before upload.

1. Sign in as an administrator at `/classroom/`. Open **Manage classroom** and select the compiled file. **Upload privately** creates a draft.
2. Preview the new set. Check the staged hints, each worked answer, and any interactive views in both study modes.
3. Set **Student visibility** for questions and solutions independently. Save the settings. Check a student account to verify exactly what was released.
4. To revise the same set, keep the set ID, preserve the IDs of existing questions, rebuild and select **Replace privately**. Review the new revision and choose its visibility again. Use a new set ID for a distinct assignment.

The private authoring folder is the editable source. Keep it with the teacher's private materials so future revisions can be rebuilt.
