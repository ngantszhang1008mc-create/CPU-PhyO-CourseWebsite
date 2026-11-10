import './package-widget.css';
import { createElement, useId, useState, type ReactNode } from 'react';
import type { GraphicNode, InteractiveBlock } from '../lib/lesson-package';

function renderFrame(node: GraphicNode, key = 0): ReactNode {
  if (typeof node === 'string') return node;
  return createElement(node.tag, { ...node.attrs, key }, ...node.children.map(renderFrame));
}

export default function PackageWidget({ block }: { block: InteractiveBlock }) {
  const { control, frames, title } = block;
  const indexFor = (value: number) => Math.round((value - control.min) / control.step);
  const initial = indexFor(control.initial);
  const [index, setIndex] = useState(initial);
  const current = Math.min(frames.length - 1, index);
  const value = Number((control.min + current * control.step).toPrecision(12));
  const label = String(value) + (control.unit ? ' ' + control.unit : '');
  const id = useId();
  return (
    <section className="package-widget" aria-label={title}>
      <h4>{title}</h4>
      <div className="package-frame">{renderFrame(frames[current])}</div>
      <label htmlFor={id}>
        {control.label} <output htmlFor={id}>{label}</output>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={frames.length - 1}
        step={1}
        value={current}
        aria-valuetext={label}
        onChange={(event) => setIndex(Number(event.target.value))}
      />
      <div className="package-presets">
        {(control.presets ?? []).map((preset, i) => (
          <button type="button" key={i} onClick={() => setIndex(indexFor(preset.value))}>
            {preset.label}
          </button>
        ))}
        <button type="button" onClick={() => setIndex(initial)}>
          Reset
        </button>
      </div>
    </section>
  );
}
