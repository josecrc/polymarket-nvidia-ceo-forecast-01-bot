import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels requested by the competition: [0.05, 0.25, 0.5, 0.75, 0.95] */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];

/** Calibrated quantile offsets with fat-tail adjustments */
const Z = [-1.75, -0.62, 0, 0.62, 1.75];

interface CaseMarket {
  id: string;
  name?: string;
  slug?: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/**
 * Strict probability clamping: clamps to [0, 1] interval and rounds to 6 decimal places.
 * Ensures non-negative zero representation.
 */
const price6 = (x: number): number => {
  const clamped = Math.min(1, Math.max(0, x));
  return Math.round(clamped * 1e6) / 1e6 + 0;
};

/**
 * Adaptive forecasting model with realized volatility estimation.
 */
function forecast(m: CaseMarket, horizon: number): number[][] {
  const p = m.prices;
  if (!p || p.length === 0) throw new Error(`Market ${m.id} has no prices`);
  const x = p[p.length - 1] as number;

  // Estimate realized volatility using squared diffs over the trailing window (120 min max)
  const win = Math.min(p.length - 1, 120);
  let ssq = 0;
  for (let i = p.length - win; i < p.length; i++) {
    const diff = p[i] - p[i - 1];
    ssq += diff * diff;
  }
  const empiricalVol = win > 0 ? Math.sqrt(ssq / win) : 0.001;
  // Apply calibrated scaling parameter 0.38 with protective bounding
  const sigma = Math.min(0.003, Math.max(0.0001, empiricalVol * 0.38));

  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    // Sublinear diffusion scaling Math.pow(h, 0.6) for fat tails and long-range clustering
    const diff = Math.pow(h, 0.6);
    const row = Z.map((z) => price6(x + z * sigma * diff));
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();

for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) {
    throw new Error(`Unexpected quantiles specification in ${file}`);
  }
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
