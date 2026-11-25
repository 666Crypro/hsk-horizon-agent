// Deterministic signal engine. The LLM (optional) can only veto or shrink what this proposes,
// and the vault contract enforces hard limits on top of both.
export const RISK_PROFILES = {
  low: { entry: 0.006, sizeFrac: 0.25, targetExposure: 0.4, trail: 0.04 },
  medium: { entry: 0.0035, sizeFrac: 0.5, targetExposure: 0.6, trail: 0.06 },
  high: { entry: 0.002, sizeFrac: 1.0, targetExposure: 0.8, trail: 0.08 },
};

export const POOL_FEE = 0.003;

/**
 * @param m market snapshot from readMarket
 * @param ref {price} | null  off-chain reference
 * @param v vault snapshot {baseBal, quoteBal, nav, dailyRemaining, maxTradeQuote} in whole units
 * @param s user settings {riskAppetite, maxTradeUsd}
 */
export function decide(m, ref, v, s) {
  const p = RISK_PROFILES[s.riskAppetite] ?? RISK_PROFILES.medium;
  const t5 = m.twaps[300] ?? m.spot;
  const t15 = m.twaps[900] ?? t5;
  const t60 = m.twaps[3600] ?? t15;
  const signals = {
    momentum: (t5 - t60) / t60, // short vs long TWAP
    meanReversion: (m.spot - t15) / t15, // spot stretch vs 15m TWAP
    refSpread: ref ? (m.spot - ref.price) / ref.price : null, // DEX vs CEX reference
  };
  const exposure = v.nav > 0 ? (v.baseBal * t15) / v.nav : 0;
  const reasons = [];
  let action = 'hold';
  let score = 0;

  // 1) spread / arbitrage-style signal: DEX mispriced vs off-chain reference by more than fee + entry
  const spreadEdge = POOL_FEE + p.entry;
  if (signals.refSpread !== null && signals.refSpread < -spreadEdge) {
    action = 'buy';
    score = Math.min(1, -signals.refSpread / (spreadEdge * 3));
    reasons.push(`DEX ${(signals.refSpread * 100).toFixed(2)}% below reference (${ref.source}); edge after 0.30% fee`);
  } else if (signals.refSpread !== null && signals.refSpread > spreadEdge && v.baseBal > 0) {
    action = 'sell';
    score = Math.min(1, signals.refSpread / (spreadEdge * 3));
    reasons.push(`DEX ${(signals.refSpread * 100).toFixed(2)}% above reference (${ref.source}); take the spread`);
  }
  // 2) trend: short TWAP vs long TWAP, but don't chase a stretched spot
  else if (signals.momentum > p.entry && signals.meanReversion < p.entry * 2) {
    action = 'buy';
    score = Math.min(1, signals.momentum / (p.entry * 3));
    reasons.push(`uptrend: 5m TWAP ${(signals.momentum * 100).toFixed(2)}% over 1h TWAP`);
  } else if (signals.momentum < -p.entry && v.baseBal > 0) {
    action = 'sell';
    score = Math.min(1, -signals.momentum / (p.entry * 3));
    reasons.push(`downtrend: 5m TWAP ${(signals.momentum * 100).toFixed(2)}% under 1h TWAP, de-risk`);
  } else {
    reasons.push(`no edge: momentum ${(signals.momentum * 100).toFixed(2)}%, stretch ${(signals.meanReversion * 100).toFixed(2)}%`);
  }

  // exposure targeting
  if (action === 'buy' && exposure >= p.targetExposure) {
    reasons.push(`exposure ${(exposure * 100).toFixed(0)}% already at ${s.riskAppetite} target ${(p.targetExposure * 100).toFixed(0)}%`);
    action = 'hold';
  }

  const cap = Math.min(s.maxTradeUsd, v.maxTradeQuote, v.dailyRemaining);
  let sizeUsd = action === 'hold' ? 0 : cap * p.sizeFrac * Math.max(0.25, score);
  if (action === 'buy') sizeUsd = Math.min(sizeUsd, v.quoteBal * 0.98, Math.max(0, (p.targetExposure - exposure) * v.nav));
  if (action === 'sell') sizeUsd = Math.min(sizeUsd, v.baseBal * t15 * 0.98);
  if (action !== 'hold' && sizeUsd < 1) {
    reasons.push('size below 1 USDT after limits');
    action = 'hold';
    sizeUsd = 0;
  }

  // trailing stop suggestion (agent may only tighten on-chain)
  const trailStop = v.baseBal > 0 ? t15 * (1 - p.trail) : null;

  return { action, sizeUsd: Number(sizeUsd.toFixed(2)), score: Number(score.toFixed(3)), signals, exposure, reasons, trailStop, profile: s.riskAppetite };
}
