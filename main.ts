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
/**
 * Compute empirical realized volatility over the specified lookback window.
 * Calculates root-mean-square of consecutive 1-minute price differentials.
 */
function computeRealizedVolatility(priceSeries: number[], windowMinutes: number = 120): number {
  const effectiveWindow = Math.min(priceSeries.length - 1, windowMinutes);
  if (effectiveWindow <= 0) return 0.001;
  let sumSquaredDiff = 0;
  for (let idx = priceSeries.length - effectiveWindow; idx < priceSeries.length; idx++) {
    const delta = priceSeries[idx] - priceSeries[idx - 1];
    sumSquaredDiff += delta * delta;
  }
  return Math.sqrt(sumSquaredDiff / effectiveWindow);
}

/**
 * Generate 5 calibrated quantile trajectories for a single market across the forecast horizon.
 * Incorporates 0.38 volatility scaling, sublinear diffusion (h^0.6), and quantile spreads.
 */
function forecastMarket(market: CaseMarket, horizonMinutes: number): number[][] {
  const prices = market.prices;
  if (!prices || prices.length === 0) {
    throw new Error(`Market ${market.id} contains no price history`);
  }
  const lastPrice = prices[prices.length - 1] as number;
  const empiricalVol = computeRealizedVolatility(prices, 120);
  const calibratedSigma = Math.min(0.003, Math.max(0.0001, empiricalVol * 0.38));

  const quantileRows: number[][] = [];
  for (let step = 1; step <= horizonMinutes; step++) {
    const diffusionFactor = Math.pow(step, 0.6);
    const quantileRow = Z.map((quantileZ) =>
      price6(lastPrice + quantileZ * calibratedSigma * diffusionFactor)
    );
    quantileRows.push(quantileRow);
  }
  return quantileRows;
}

// Ensure output directory exists before generating predictions
mkdirSync(OUTPUT_DIR, { recursive: true });
const inputCases = readdirSync(INPUT_DIR).filter((fname) => fname.endsWith('.in')).sort();

for (const caseFile of inputCases) {
  const caseId = caseFile.slice(0, -'.in'.length);
  const rawData = readFileSync(join(INPUT_DIR, caseFile), 'utf8');
  const parsedCase = JSON.parse(rawData) as Case;

  if (
    parsedCase.quantiles.length !== QUANTILES.length ||
    parsedCase.quantiles.some((val, idx) => val !== QUANTILES[idx])
  ) {
    throw new Error(`Incompatible quantiles specification detected in case file: ${caseFile}`);
  }

  const forecasts = parsedCase.markets.map((mkt) => ({
    id: mkt.id,
    q: forecastMarket(mkt, parsedCase.horizon_minutes)
  }));

  const resultPayload = JSON.stringify({ forecasts });
  writeFileSync(join(OUTPUT_DIR, `${caseId}.out`), `${resultPayload}\n`);
}
