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
      [
        { kind: 'text', value: 'How does the braking direction compare with the motion?' },
        { kind: 'image', src: './figures/braking-setup.png',
          alt: 'On a level track the cart moves right at 4 m/s; its acceleration is 2 m/s² to the left.' },
      ],
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

For this example, draw the setup asset at `figures/braking-setup.png` and create the `Braking.tsx` view below.

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

## Redraw figures in the Problem Set 1 style

Redraw each source question figure in the classroom’s visual style. Use the authorized original to recover its physics and data. Draw fresh lines, labels, objects and axes from that specification. A tinted scan, screenshot, PDF crop or traced bitmap still carries the original page’s typography and line quality. For plots, use the defining data or equations where known. For apparatus, vectors and geometry, use editable drawing primitives. Keep the drawing script or editable artwork in the private source package beside the exported figure.

When the teacher supplies Set 1 as a visual reference, compare the finished figures side by side at the same displayed width. Its question figures provide the reference for student-facing artwork. Its hint and solution pairs show how to develop a diagram as the reasoning progresses. The specifications below can also be used independently. Keep real Set 1 figures and source material out of the public guide and build.

### Colour and type

These are sampled Set 1 colours. Start with the question palette for all statement figures. Pick one supporting palette for a related group of hints and solutions. Keep each object or quantity identifiable across the group.

| Use | Colours and application |
| --- | --- |
| Question figures | Paper `#FAF7EF`, ink `#20251F`, light rules/grid `#DDD9CB`, sage `#688161`, ochre `#B26921`. Use ink for labels, ticks, axes and point centres. A graph with one data series generally needs only sage. |
| Vector and geometry explanations | Paper `#FBF8F1`, ink `#252C30`, blue `#336487`, ochre `#AC5C21`, green `#47735B`, guide lines `#BAB9AC`. Where the boundary between two materials matters, fill each region once with a pale flat tint, such as water `#E5EDF2` and sand `#F3E8D7`. |
| Motion and comparison explanations | Paper `#F8F5EC`, ink `#252D29`, green `#416E61`, orange `#AE601C`, secondary labels `#55655E`, construction lines `#90998E`, shaded area `#DCE6D6`. Another Set 1 pairing uses green `#396B59` and orange `#A75323` on `#FBF9F2`. |
| Typography | Use Arial or a metrically similar plain sans serif inside figures. Use regular weight for quantities, units and axes. Reserve bold for panel letters, short comparison headings, or the quantity being emphasized. The page supplies Barlow Condensed headings, serif prose and KaTeX equations. Keep those in their respective content blocks. |

A colour has meaning **within the figure**. For example, sage can mark one body and ochre the other, or sage can show a measured trace and ochre the current reading. Directly label each series, vector or body. Use a dot, outline, line pattern or short legend as a second cue. Leave the pink topic tags, amber answer boxes, borders and section headings to the reader. Use flat fills and clean lines without gradients, shadows, photographic textures, decorative icons or a frame around the entire picture.

### Size, spacing and marks

- Use a wide canvas with one clear reading direction. Set 1 statement figures include shallow strips around 800–880 × 215–270 px and taller graphs around 710–780 × 380–393 px. Choose the height to suit the physics. For new explanatory diagrams, a useful Set 1 starting point is **500 × 226** or **560 × 250 logical units**, rendered at **2×** to a 1000 or 1120 px wide PNG.
- The following dimensions are in logical units before the 2× export. Use about **2** for axes, rods and outlines, **2.5–3.5** for an emphasized arrow or curve, and **1–1.5** for construction lines, projection guides and dimensions. Use small filled point markers of radius **4–5**. Use a short arrowhead around **8–11** long, aligned with the shaft and ending at the actual tip. A filled triangle works well for vectors. A slim open head also works for a motion arrow if used consistently.
- Use short dashes for projections and guides, typically **5 on / 4–5 off**. Use solid lines for physical edges or data, and give a dashed physical continuation or anticipated path an explicit label if it could be mistaken for a construction line. Draw dimensions with thin end ticks or a bracket, offset from the object. Show angles with a small arc and place the label alongside it.
- On a 500–560-unit canvas, start with **16–20** for primary labels, **14–17** for secondary labels and **18–22** for short emphasized labels. Keep units attached to quantities and check superscripts, subscripts, minus signs, Greek letters and degree signs in the exported image. Use KaTeX below the image for multi-line algebra.
- Reserve margin for arrowheads, tick labels, captions and motion at extreme positions. Place labels beside their own elements, clear of line crossings. Stagger or move labels with short leaders when points cluster. If a diagram is crowded, split the stages into separate figures. The reader constrains the question column to 85ch and static images to the available width and 420 px height. Shrinking an entire page of diagrams into one PNG makes labels unreadable.

### Compose the figure for its job

| Figure | How to draw it |
| --- | --- |
| Diagram-based multiple choice | Give the alternatives equal space and the same orientation, scale, line weight and emphasis. In Set 1 a single shallow strip uses faint vertical dividers, a short shared legend where useful, and bold A–E letters centred below the drawings. Match the source letters and order exactly. Keep every physical difference that distinguishes an option. If a strip becomes unreadable on a phone, split it across stacked rows with the same lettering and scale. |
| Vectors and forces | Draw the origin, point of application and arrow tip precisely. Preserve collinearity, relative angles, head-to-tail or common-tail construction, and any encoded length ratios. Label the frame and positive direction when they matter. A free-body diagram for another topic should isolate the chosen body and attach and label each force according to the given model. |
| Quantitative graphs | Use dark axes, short ticks, legible scales, and quantity names with units. Use an understated regular grid when the student must read a value. Make the zero line distinguishable when signs matter. Plot the actual curve or line segments, retaining endpoints, discontinuities, extrema and crossings. Mark measured points or meaningful corners with small dots. Use a light fill for area only when that area has a physical meaning. |
| Position strips, grids and sequences | Use the same scale and reference line across the sequence. Put dots at the actual sample positions. Preserve unequal spacing, direction of time and equal-time sampling. A square grid used to measure a length must stay square on screen and include its scale. Use short leaders or alternating label heights if needed. |
| Apparatus and geometry | Reduce bodies to clear dots, blocks, outlines, tracks, surfaces and connecting lines. Preserve contact versus separation, joints, boundaries, lengths and angles. Use a flat region fill only where it clarifies the setup. Draw symbols for the appropriate physics, including standard circuit symbols where relevant. A schematic may enlarge a small distance for legibility if the figure says so. Keep measured graphs and scale-dependent questions geometrically faithful. |
| Before/after or competing cases | Use matched panels or aligned rows with a common origin, baseline and scale. Keep colours tied to the same objects. Label each stage in a few words and change only the variables that actually differ. Avoid reorienting or mirroring one panel silently. |

### Control what the student sees

1. **Question.** Place the redrawn figure in `statement` beside the text that refers to it. Preserve all givens, unknowns, labels, units, option cues and original precision. Leave out auxiliary constructions, computed values and highlights that would identify the answer. Check the alt text with the same rule. An alt description of a graph should communicate its relevant coordinates or shape.
2. **Hint.** For a descriptive word-only question, draw the setup in a staged hint. Show what is given, what is being sought and the relevant direction or reference level. Use a symbol or question mark for the unknown. A short prompt in a text block should tell the student what to look for.
3. **Worked solution.** Reuse the geometry, symbols and colours of the setup. Add the construction that explains the next reasoning step, such as a component projection, equal lengths at two instants, a signed area, or a pair of comparable forces. A worked visual earns its place by showing why the relationship holds. Add numerical results only at the appropriate step. Give the visual its own alt text. Preserve a complete calculus-free argument in the surrounding blocks.
4. **Interactive view.** Use the same visual conventions and a responsive SVG `viewBox`. Set 1 views are roughly 320–340 units wide by 174–190 high, with 2–3-unit data strokes, 4–5-unit moving markers and short 11–14-unit labels. Keep the frame and axes steady as the slider moves. Derive the drawing, units, accessible description and numerical readout from the same parameter. Place the readout beneath the drawing and use the reader’s slider, presets and reset. Check the initial value, both endpoints and any meaningful transition.

### Export and inspect

Use an optimized PNG for line art. Set 1's explanatory figures use about 96–128 palette colours after the 2× render, enough to preserve antialiased lettering on cream. Keep the editable generator reproducible with local inputs and include a usable sans-serif fallback if its preferred font is unavailable. Leave paths relative to the lesson entry and embed the exported assets through the compiler.

Before handoff, compare **every** redrawn figure against its authorized source. Check directions, scales, values, relative lengths, connections, panel letters and the details that distinguish the correct choice from each distractor. Then inspect the compiled reader at desktop width, a 360–390 px phone width and in print preview. Read the smallest labels at actual size, check clipping and overlaps, and confirm that grayscale still distinguishes the cases. Inspect question-only visibility for answer leaks, reveal each hint in order, and inspect worked figures in guide mode. Check slider endpoints with the keyboard. If a mark in the original is illegible or ambiguous, record the specific question and uncertainty for the teacher rather than guessing its value.

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
