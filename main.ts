// GTA VI launch-day Twitch forecast: a weighted launch-shape regression over the
// comparable games. Each comparable contributes r_h = log(viewers_h / viewers_1) for
// every hour h of its own UTC release day, weighted toward games that left the gate the
// way GTA VI will (midnight rolling unlock, console-only release) and toward games whose
// hour-1 crowd resembles the case's. Per hour, the weighted mean and spread of r_h,
// lightly smoothed over neighbouring hours, place the five quantiles around hour 1's
// print: q = p1 * exp(center + z * spread).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Standard normal quantiles at levels [0.05, 0.25, 0.50, 0.75, 0.95], the output order.
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const FIRST_HOUR = 2;
const LAST_HOUR = 24;
const MAX_VIEWERS = 1e9;
const HOUR_MS = 3_600_000;

type Point = { from: string; viewers: number; channels?: number | null };
type Comparable = { name: string; day_start: string; unlock: string; platforms: string; hourly: Point[] };
type Case = {
  id: string;
  known: Array<{ hour: number; viewers: number }>;
  notes: string;
  comparables: Comparable[];
};

type Shape = { ratios: Map<number, number>; weight: number };

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A comparable's viewers by hour 1..24 of its UTC release day. */
function hoursOf(comparable: Comparable): Map<number, number> {
  const day = Date.parse(comparable.day_start ?? '');
  const hours = new Map<number, number>();
  if (!Number.isFinite(day)) return hours;
  for (const point of comparable.hourly ?? []) {
    const at = Date.parse(point?.from ?? '');
    const viewers = point?.viewers;
    if (!Number.isFinite(at) || typeof viewers !== 'number' || !(viewers > 0)) continue;
    const hour = Math.floor((at - day) / HOUR_MS) + 1;
    hours.set(hour, viewers);
  }
  return hours;
}

/** The comparable's launch shape, or null when it is too thin or too quiet to use. */
function shapeOf(comparable: Comparable, midnight: boolean, console: boolean, p1: number): Shape | null {
  const hours = hoursOf(comparable);
  const first = hours.get(1);
  if (first === undefined || first < 10 || hours.size < 10) return null;

  const ratios = new Map<number, number>();
  for (let hour = FIRST_HOUR; hour <= LAST_HOUR; hour += 1) {
    const viewers = hours.get(hour);
    if (viewers !== undefined && viewers > 0) ratios.set(hour, Math.log(viewers / first));
  }

  const name = comparable.name ?? '';
  const unlock = comparable.unlock ?? '';
  const platforms = comparable.platforms ?? '';
  let weight = 1;
  if (midnight && /midnight/i.test(unlock)) weight *= 2.5;
  if (console && /PS|Xbox|Switch/.test(platforms) && !/PC/.test(platforms)) weight *= 1.8;
  if (/early access|premium|beta|test|network/i.test(unlock)) weight *= 0.25;
  weight *= 1 / (1 + 0.35 * Math.abs(Math.log(p1 / first)));
  if (/red dead redemption/i.test(name)) weight *= 2;

  return { ratios, weight };
}

/** Weighted mean and (population) standard deviation of the ratios present for an hour. */
function hourStats(shapes: Shape[], hour: number): { mean: number; sd: number; count: number } {
  let total = 0;
  let mean = 0;
  let count = 0;
  for (const shape of shapes) {
    const r = shape.ratios.get(hour);
    if (r === undefined || !Number.isFinite(r)) continue;
    total += shape.weight;
    mean += shape.weight * r;
    count += 1;
  }
  if (total <= 0) return { mean: 0, sd: 0, count: 0 };
  mean /= total;
  let variance = 0;
  for (const shape of shapes) {
    const r = shape.ratios.get(hour);
    if (r === undefined || !Number.isFinite(r)) continue;
    variance += shape.weight * (r - mean) ** 2;
  }
  return { mean, sd: Math.sqrt(variance / total), count };
}

function forecastCase(c: Case): Array<{ hour: number; q: number[] }> {
  const p1 = Math.max(1, c.known?.find((row) => row.hour === 1)?.viewers ?? 1);
  const notes = c.notes ?? '';
  const midnight = /midnight|rolling|12 AM local/i.test(notes);
  const release = notes.match(/released on ([^.;]+)/i)?.[1] ?? '';
  const consoleTarget = /PS|Xbox|Switch/.test(release) && !/PC/.test(release);

  const shapes = (c.comparables ?? [])
    .filter((comparable) => !/grand theft auto/i.test(comparable.name ?? ''))
    .map((comparable) => shapeOf(comparable, midnight, consoleTarget, p1))
    .filter((shape): shape is Shape => shape !== null);

  const mean = new Map<number, number>();
  const sd = new Map<number, number>();
  const count = new Map<number, number>();
  for (let hour = FIRST_HOUR; hour <= LAST_HOUR; hour += 1) {
    const stats = hourStats(shapes, hour);
    mean.set(hour, stats.mean);
    sd.set(hour, stats.sd);
    count.set(hour, stats.count);
  }

  // The nearest hour that has samples, for hours the comparables do not cover.
  const nearest = (hour: number): number => {
    for (let step = 1; step <= LAST_HOUR; step += 1) {
      if ((count.get(hour - step) ?? 0) >= 4) return hour - step;
      if ((count.get(hour + step) ?? 0) >= 4) return hour + step;
    }
    return hour;
  };

  const hours: Array<{ hour: number; q: number[] }> = [];
  for (let hour = FIRST_HOUR; hour <= LAST_HOUR; hour += 1) {
    let center: number;
    let spread: number;
    if ((count.get(hour) ?? 0) >= 4) {
      const here = mean.get(hour)!;
      const prev = mean.get(hour - 1) ?? here;
      const next = mean.get(hour + 1) ?? here;
      const smoothed = 0.25 * prev + 0.5 * here + 0.25 * next;
      center = 0.75 * here + 0.25 * smoothed;
      spread = clamp(sd.get(hour)!, 0.1, 0.65) * 0.9;
    } else {
      center = mean.get(nearest(hour)) ?? 0;
      spread = 0.15 * Math.sqrt(hour - 1);
    }

    const q = Z.map((z) => {
      const value = p1 * Math.exp(center + z * spread);
      const finite = Number.isFinite(value) ? value : MAX_VIEWERS;
      return clamp(Math.round(finite * 100) / 100, 1, MAX_VIEWERS);
    });
    for (let i = 1; i < q.length; i += 1) if (q[i] < q[i - 1]) q[i] = q[i - 1];
    hours.push({ hour, q });
  }
  return hours;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const files = readdirSync(INPUT_DIR)
  .filter((name) => name.endsWith('.in'))
  .sort();
for (const file of files) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: forecastCase(c) })}\n`);
}
