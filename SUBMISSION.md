# DoraHacks BUIDL draft — HSK Sentinel

**Do not submit this automatically.** Copy the fields below into a new BUIDL on the [HSK Chain Horizon Hackathon · Seoul](https://dorahacks.io/hackathon/hskchainseoul/detail) page after the GitHub repo is public. Deadline: **Wednesday, December 2, 2026, 8:00 PM Pacific Time** (Thursday, December 3, 2026, 13:00 KST).

Proposed GitHub repo (not created in this pass; publish only after you approve): **https://github.com/666Crypro/hsk-horizon-agent**

---

## Track and why

**Track 1 — AI Agent Trading** (6,000 USDT pool: 3,000 / 2,000 / 1,000).

This is the better solo-builder shot:

- The track's official recommended venue is a DEX such as **HSKSwap**. Sentinel talks to the live HSKSwap WHSK/USDT 0.3% pool, SwapRouter02 and QuoterV2 — that is the bonus-points "officially recommended product" path.
- Every listed requirement maps onto a demoable feature: market monitoring, signals, autonomous execution, spread detection, strict risk/stop-loss, and a conversational control surface for positions, PnL, size, frequency, risk appetite and target assets.
- The distinctive claim is easy to show in a 2–3 minute video: a hallucinating or compromised agent **cannot** exceed the policy, and a permissionless keeper still exits if the agent's server is down.
- Track 2 (Agent Payments & A2A Settlement) needs the HSP Gateway / MCP flow, merchant credentials and live mandate signing. Those APIs are not something we can honestly finish and demo without your accounts, and they are a weaker fit for a weekend solo build.

Individuals may enter. Winners must deploy on **HSK Chain mainnet (chain 177)** to claim a prize. Demo Day is December 5 in Seoul (online presentation is allowed for teams outside Korea); winners are announced December 6.

---

## BUIDL form (paste-ready)

**Project name:** HSK Sentinel

**Tagline:** An AI trading agent for HSKSwap that cannot blow up your wallet — the agent decides, a smart contract on HSK Chain enforces the limits.

**Track:** AI Agent Trading

**One-paragraph summary:**
Autonomous DEX agents usually fail in two ways: the strategy is wrong, or the agent itself goes wrong — a hallucinated size, `minOut = 0`, a leaked hot key, a crashed server in a crash. HSK Sentinel splits the roles. A human owner deposits WHSK and USDT into `SentinelVault` and signs a risk policy (per-trade and daily caps, TWAP-anchored slippage, spot/TWAP manipulation guard, max exposure, drawdown breaker, stop-loss / take-profit). An AI agent hot key can only trade inside that policy, on the HSKSwap WHSK/USDT pool. The agent watches on-chain TWAPs and an off-chain reference price, proposes trades, optionally runs them past an LLM "risk officer" that may veto or shrink a trade but never enlarge it, and writes `keccak256` of the full decision record on-chain with every fill. If the agent is offline, anyone can trigger the stop. We verified the contract with Foundry unit, fuzz and a fork of HSK mainnet against the real HSKSwap pool, plus a scripted end-to-end demo.

**Long description (markdown, for the BUIDL body):**

```markdown
## The problem

Most "AI trading agents" keep the risk policy in the bot. If the model hallucinates a size, sets `minOut = 0`, or the hot key leaks, the vault is gone. If the process dies during a crash, the stop-loss never fires.

## What we built

**SentinelVault** (Solidity 0.8.26, HSK Chain) is a risk-bounded vault bound at deploy time to the HSKSwap WHSK/USDT 0.3% pool:

- Per-trade and per-UTC-day notional caps, trade cooldown
- `minOut` must be at least the TWAP-fair output minus `maxSlippageBps` — a hallucinated `minOut = 0` reverts (`MinOutTooLoose`)
- Spot vs TWAP deviation guard — the agent cannot buy a one-block wick (`PriceDeviation`)
- Max base-asset exposure after a buy
- NAV drawdown circuit breaker, valued at TWAP; deposits/withdrawals rescale the high-water mark
- Stop-loss and take-profit that **anyone** can execute; they trigger on the TWAP (a wick cannot fire them) and the exit `minOut` is TWAP-anchored so a keeper cannot sandwich the fill
- The agent may only *tighten* a stop-loss, and never below the owner's floor
- Every agent trade carries `reasonHash = keccak256(canonical JSON of the decision)` — a tamper-evident journal
- Exact router allowances, reset to 0 after every swap; reentrancy lock; USDT-safe transfers

**The agent** (Node, ethers v6) is the conversational, autonomous client:

- Reads 1m / 5m / 15m / 1h TWAPs from the pool oracle and executable quotes from QuoterV2
- Signals: trend (5m vs 1h TWAP), stretch (spot vs 15m TWAP), DEX vs CEX reference spread (only trades when the edge clears the 0.30% fee)
- `npm run chat` / `npm run agent`: "how am I doing?", "trade 40 USDT max", "be more conservative", "check every 5 minutes", "what can you trade?", "stop 3%", "any arbitrage?", "show trades"
- Optional LLM risk officer (any OpenAI-compatible endpoint) may veto or shrink a trade, never enlarge it
- Permissionless keeper (`npm run keeper`) and a live dashboard (`npm run dashboard`)

## How to verify

```bash
git clone https://github.com/666Crypro/hsk-horizon-agent && cd hsk-horizon-agent
cd contracts && forge test
HSK_FORK=1 forge test --match-contract Fork -vv
cd ../agent && npm install && npm test && npm run demo
```

`npm run demo` forks HSK Chain mainnet, deploys the vault against the *real* HSKSwap pool, and walks through chat configuration, a refused wick-buy, a confirmed-TWAP entry, a rogue agent getting reverted, and a crash where a keeper runs the stop while the agent is offline.

We have not claimed any profit. The contracts are unaudited hackathon code.

## HSK Chain / HSKSwap addresses used

- Chain ID 177, RPC https://mainnet.hsk.xyz, explorer https://hsk.blockscout.com
- Pool `0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC`
- SwapRouter02 `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3`
- QuoterV2 `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD`
- WHSK `0xB210D2120d57b758EE163cFfb43e73728c471Cf1`
- USDT `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029`
```

**Tags / tech:** Solidity, Foundry, HSK Chain, HSKSwap, Uniswap V3, ethers.js, AI agent, TWAP, stop-loss

**Demo URL:** (local) `npm run demo` and `npm run dashboard` at http://localhost:8788 — replace with a recorded video URL after you publish it.

**Demo video URL:** *paste your YouTube / X / Google Drive link after recording (script below).*

**Repository:** https://github.com/666Crypro/hsk-horizon-agent *(after you approve publishing)*

**Contract address (testnet / mainnet):**
- Testnet: not yet deployed. Official faucet is captcha-gated; the known HSKSwap addresses have no code on chain 133. A funded-deployer checklist is at the bottom of this file. Fresh deployer (no funds, key is gitignored): `0x481496f054370FcBDe0Cb150992a8824C57129ad`
- Mainnet: deploy only if you are selected for Demo Day or are claiming a prize. Do not spend real HSK until then. Command is in the README.

**Pitch deck:** optional. If the form asks for slides, a 5-slide outline is included below; export it to PDF/Google Slides and attach it.

**Team:** Individual — Arthur Shavlovsky (GitHub `666Crypro`).

---

## 5-slide pitch outline (optional deck)

1. **Title.** HSK Sentinel — an AI agent for HSKSwap that cannot blow up your wallet. Track 1, HSK Chain Horizon Hackathon · Seoul.
2. **Problem.** Strategy risk vs. agent risk (hallucination, leaked key, dead server). Most bots only address the first.
3. **Architecture.** Owner (cold) vs agent (hot) vs anyone (keeper). Vault bound to HSKSwap WHSK/USDT. Diagram from the README.
4. **Proof.** Foundry unit + fuzz + mainnet-fork test; scripted demo: wick refused, confirmed entry filled, rogue agent reverted, keeper stop-loss while the agent is offline; decision journal verified on-chain.
5. **Ask / next.** Mainnet deploy of the vault with a tight policy and a small deposit if selected; optional LLM risk officer; more pairs as additional vaults. Unaudited, no profit claimed.

---

## Demo video script (2–3 minutes)

Record your screen (terminal + a second window for the dashboard if you like) and talk over it. Suggested total: **about 2 minutes 30 seconds**. Run `KEEP_FORK=1 npm run demo` first if you want the fork still up at the end, or record a fresh `DEMO_PAUSE_MS=400 npm run demo`.

**[0:00–0:20] Hook**
> "Most AI trading agents keep the risk limits in the bot. If the model hallucinates a size, or the server dies in a crash, you eat the loss. HSK Sentinel puts those limits on HSK Chain, in a vault the agent cannot override."

**[0:20–0:45] Architecture, one diagram**
Show the mermaid / README diagram (or a terminal tree).
> "A human owner deposits WHSK and USDT and signs the policy — trade size, daily cap, TWAP slippage, a manipulation guard, max exposure, a drawdown breaker, and a stop-loss. The AI gets a hot key that can only call `trade()`. Anyone can run the stop if we're offline. Every decision is hashed on-chain."

**[0:45–1:10] Conversational control**
Play the chat section of `npm run demo` (or type live: "how am I doing?", "trade 40 USDT max", "be more aggressive", "what can you trade?", "stop 3%").
> "You talk to it in plain English. Position size, risk, frequency, assets, stops. When I asked it to loosen the stop, the contract refused — the agent may only tighten."

**[1:10–1:40] The wick and the real fill**
Show the whale dump, the `any arbitrage?` scan, and `PriceDeviation` revert, then the fill 10 minutes later with a verified `reasonHash`.
> "A whale dumps into HSKSwap. The agent sees a 2% discount and wants to buy — and the vault says no, because spot is too far from the TWAP. That's a possible manipulation. Ten minutes later the TWAP has caught up, the discount is still there, and the trade fills. The reason hash on the event matches the journal file on disk."

**[1:40–2:15] Rogue agent + keeper stop**
Show the four reverts, then the crash with the agent offline and the keeper retries until stop-loss executes.
> "Now I pretend the agent is compromised: a 500-dollar market buy, a sandwich-bait `minOut` of zero, a withdraw to itself, a loosened stop. All four revert. Then I crash the market and I take the agent offline. A one-block wick does not fire the stop. Once the TWAP crosses the line, a random keeper sells the inventory — even though our bot is down."

**[2:15–2:30] Close**
Show the final `status` / `show trades` / dashboard.
> "Final book: the stop did its job, the journal verifies, no profit claimed. This is HSK Sentinel, Track 1, built on HSK Chain and HSKSwap. Repo is in the BUIDL. Thanks."

Record in 1080p, keep the terminal font large, and upload unlisted to YouTube (or X / Drive if the form allows). Paste the URL into the BUIDL before the deadline.

---

## Arthur's checklist (must be done by Wed Dec 2, 2026, 8:00 PM PT)

Do these yourself. Nobody should register, submit, log in to DoraHacks, post on X, sign a mainnet transaction, or spend money on your behalf.

### Before you submit

1. **Approve publishing the repo**, then create a **public** GitHub repository `666Crypro/hsk-horizon-agent` and push the `main` branch from this tree (`/workspace/hsk-horizon-entry`). Do not commit `.env`, `.secrets/`, or any key.
2. **Register on DoraHacks** for [HSK Chain Horizon Hackathon · Seoul](https://dorahacks.io/hackathon/hskchainseoul/detail) as an individual and open a new BUIDL. Paste the fields above. Select **AI Agent Trading**.
3. **(Recommended) Fund the testnet deployer and deploy the mock fixture**, so the BUIDL can show a contract on HSK testnet (chain 133):
   1. Add HSK Chain Testnet to your wallet: RPC `https://testnet.hsk.xyz`, chain ID `133`, symbol `HSK`, explorer `https://testnet-explorer.hsk.xyz`.
   2. Go to https://faucet.hsk.xyz (or https://faucet.hashkeychain.net / https://faucet.hskchain.net/faucet), complete the captcha, and send 1 test HSK to `0x481496f054370FcBDe0Cb150992a8824C57129ad`.
   3. From this repo, with the gitignored key already in `.secrets/deployer.key`:
      ```bash
      cd contracts
      export DEPLOYER_KEY_FILE=../.secrets/deployer.key   # do not echo this
      forge script script/DeployTestnetMocks.s.sol \
        --rpc-url hsk_testnet --broadcast \
        --private-key "$(cat ../.secrets/deployer.key)"
      # then verify on https://testnet-explorer.hsk.xyz and paste the vault address into the BUIDL
      ```
      Known mainnet HSKSwap addresses have **no code on testnet**, which is why this script deploys a self-contained mock pool. Prefer the mainnet-fork demo (`npm run demo`) as the evidence of integration with real HSKSwap.
4. **Record the demo video** from the script above (2–3 minutes). Upload it unlisted and paste the link.
5. **Optional:** turn the 5-slide outline into a short PDF or Google Slides deck and attach it if the form has a slot.
6. **Double-check** the BUIDL: track, public repo, video, (optional) testnet address, original-work confirmation. Submit before **8:00 PM PT on Wednesday, December 2, 2026**. The form closes automatically at December 3, 13:00 KST.

### After submission, only if selected (or to claim a prize)

7. **Demo Day is December 5, 2026** (Seoul, venue TBA). You may present online. December 4 is the scheduled announcement of the pitch slate.
8. **If you win (announcement December 6):** you **must deploy `SentinelVault` to HSK Chain mainnet (chain 177)** to claim the prize, using your owner wallet and a fresh agent key, with a tight policy. Do not send this from a hot key you also use elsewhere. Command:
   ```bash
   cd contracts
   OWNER=0xYourColdWallet AGENT=0xFreshAgentHotKey \
   forge script script/Deploy.s.sol --rpc-url hsk_mainnet --broadcast --interactives 1 \
     --verify --verifier blockscout --verifier-url https://hsk.blockscout.com/api/
   ```
   Then deposit a small amount you can afford to lose (the code is unaudited), set stops, and keep the agent key funded with a little HSK for gas only.
9. Prize distribution is described as within 14 working days. The organizers will not charge a fee; ignore unofficial payment requests.
10. Official channels and docs: [hackathon page](https://dorahacks.io/hackathon/hskchainseoul/detail), [HashFans one-pager](https://hashfans.io/dev-onepager), [HSK docs](https://docs.hskchain.net/docs/Developer-QuickStart).

### What you should not do

- Do not commit or paste `.secrets/deployer.key`, `AGENT_PK`, or any mainnet key.
- Do not confuse the Anvil demo address `0x38a024C0b412B9d1db8BC398140D00F5Af3093D4` with a live deployment — it only exists on a local fork.
- Do not claim backtested or live profits. The fork demo ended about −4.8% NAV after a stop-loss, which is the risk system working.
