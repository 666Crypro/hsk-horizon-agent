// Optional LLM layer (any OpenAI-compatible endpoint). Two jobs:
//   1. reviewDecision: second opinion that may VETO or SHRINK a trade, never enlarge it.
//   2. parseIntent: turn free-form chat into a structured command.
// Without LLM_API_KEY the agent runs fully on the deterministic engine and regex intents.
const BASE = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

export const llmEnabled = () => Boolean(process.env.LLM_API_KEY);

async function chatJSON(system, user) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

export async function reviewDecision(decision, market, vault) {
  if (!llmEnabled() || decision.action === 'hold') return null;
  try {
    const out = await chatJSON(
      'You are the risk officer of an autonomous DEX trading agent on HSK Chain (HSKSwap WHSK/USDT). ' +
        'Given a proposed trade, market snapshot and vault state, reply JSON {"approve":bool,"size_multiplier":number 0..1,"note":string<=200 chars}. ' +
        'Be conservative: reject trades into thin or stretched markets. You can never increase size.',
      JSON.stringify({ decision, market, vault }),
    );
    const mult = Math.max(0, Math.min(1, Number(out.size_multiplier ?? 1)));
    return { model: MODEL, approve: Boolean(out.approve), sizeMultiplier: mult, note: String(out.note ?? '').slice(0, 200) };
  } catch (e) {
    return { model: MODEL, approve: true, sizeMultiplier: 1, note: `LLM unavailable (${e.message}); deterministic engine only` };
  }
}

export async function parseIntent(text) {
  if (!llmEnabled()) return null;
  try {
    return await chatJSON(
      'Map the user message to one command for a trading agent. Reply JSON {"cmd": one of ' +
        '["status","pnl","size","risk","every","assets","stop","tp","pause","resume","tick","journal","scan","help","unknown"], "arg": string|null}. ' +
        'size arg = USDT per trade; risk arg = low|medium|high; every arg like "90s","5m"; stop/tp arg = price in USDT or percent like "5%".',
      text,
    );
  } catch {
    return null;
  }
}
