// GTA VI launch-day Twitch forecast: the shape of past launches, anchored to hour 1.
// For every case, the medians and spreads of log(viewers_h / viewers_1) over the
// case's comparable launches give each hour's five quantiles, scaled by hour 1's print.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

type Point = { from: string; viewers: number };
type Comparable = { name: string; day_start: string; hourly: Point[] };
type Case = {
  id: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Hour offsets 1..24 of a comparable's UTC release day, with its viewers. */
function hoursOf(comparable: Comparable): Map<number, number> {
  const day = Date.parse(comparable.day_start);
  const hours = new Map<number, number>();
  for (const point of comparable.hourly ?? []) {
    const at = Date.parse(point.from);
    if (!Number.isFinite(at) || !Number.isFinite(point.viewers) || point.viewers <= 0) continue;
    const hour = Math.floor((at - day) / 3_600_000) + 1;
    if (hour >= 1 && hour <= 24) hours.set(hour, point.viewers);
  }
  return hours;
}

/** log((viewers_h + 1) / (viewers_1 + 1)) for every hour the comparable has. */
function ratiosOf(comparable: Comparable): Map<number, number> | null {
  const hours = hoursOf(comparable);
  const first = hours.get(1);
  if (!first || first < 10) return null;
  const ratios = new Map<number, number>();
  for (let hour = 2; hour <= 24; hour += 1) {
    const viewers = hours.get(hour);
    if (viewers) ratios.set(hour, Math.log((viewers + 1) / (first + 1)));
  }
  return ratios.size >= 8 ? ratios : null;
}

function forecastCase(c: Case): Array<{ hour: number; q: number[] }> {
  const firstRow = c.known.find((row) => row.hour === 1);
  const p1 = Math.max(1, firstRow?.viewers ?? 1);
  const comparables = (c.comparables ?? []).filter((comp) => !/grand theft auto/i.test(comp.name));
  const rows = comparables.map(ratiosOf).filter((row): row is Map<number, number> => row !== null);

  const medians = new Map<number, number>();
  const spreads = new Map<number, number>();
  for (let hour = 2; hour <= 24; hour += 1) {
    const values = rows.map((row) => row.get(hour)).filter((v): v is number => Number.isFinite(v));
    if (values.length >= 5) {
      const mid = median(values);
      const mad = median(values.map((value) => Math.abs(value - mid)));
      medians.set(hour, mid);
      spreads.set(hour, 1.4826 * mad);
    }
  }

  const hours: Array<{ hour: number; q: number[] }> = [];
  for (const row of c.forecast) {
    const hour = row.hour;
    let center: number;
    let spread: number;
    if (medians.has(hour)) {
      const prev = medians.get(hour - 1) ?? medians.get(hour)!;
      const next = medians.get(hour + 1) ?? medians.get(hour)!;
      center = 0.25 * prev + 0.5 * medians.get(hour)! + 0.25 * next;
      spread = clamp(0.6 * spreads.get(hour)!, 0.12, 0.72);
    } else {
      center = 0;
      spread = 0.15 * Math.sqrt(hour - 1);
    }
    const q = Z.map((z) => Math.max(0.01, Math.min(1e9, p1 * Math.exp(center + z * spread))));
    // Keep the rows non-decreasing even after the clamps.
    for (let i = 1; i < q.length; i += 1) q[i] = Math.max(q[i], q[i - 1]);
    hours.push({ hour, q: q.map((value) => Math.round(value * 100) / 100) });
  }
  return hours;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const files = readdirSync(INPUT_DIR).filter((name) => name.endsWith('.in')).sort();
for (const file of files) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((level, i) => level !== LEVELS[i])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
