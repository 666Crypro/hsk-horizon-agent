# Verification log

All checks below were run on **Wednesday, November 25, 2026** in America/Los_Angeles (UTC-8), unless noted. Nothing here is a profitability claim. Demo fills use a local Anvil fork of HSK Chain mainnet and well-known Anvil test accounts, not live funds.

## HSK Chain network (live RPC)

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | **177** (`cast chain-id --rpc-url https://mainnet.hsk.xyz`) | **133** (`https://testnet.hsk.xyz`) |
| RPC | https://mainnet.hsk.xyz | https://testnet.hsk.xyz |
| Explorer | https://hsk.blockscout.com | https://testnet-explorer.hsk.xyz (also documented as https://testnet-explorer.hskchain.net) |
| Native token | HSK | HSK |
| Faucet | n/a | https://faucet.hsk.xyz → https://faucet.hashkeychain.net/ (1 HSK / 24h, captcha) |

A dry-run of `script/Deploy.s.sol` against mainnet simulated successfully at block **30635480**, ~3.25M gas. Observed `eth_gasPrice` / base fee at the time was ~500 gwei (HSK is an OP-Stack L2; the "ETH" unit in Foundry output is HSK).

## HSKSwap addresses (mainnet, verified by RPC)

Read on 2026-11-25 against `https://mainnet.hsk.xyz`:

| Role | Address | Check |
|---|---|---|
| V3 Factory | `0x972cA9D1662F5e029cD18327D29026532E84c742` | `router.factory()` returns this |
| SwapRouter02 | `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3` | `factory()` as above; `WETH9()` = WHSK |
| QuoterV2 | `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD` | used by the agent for executable quotes |
| WHSK/USDT 0.3% pool | `0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC` | `factory.getPool(WHSK, USDT, 3000)` |
| WHSK (18 dp) | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | pool `token0` |
| USDT (6 dp) | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` | pool `token1`; `decimals() == 6` |

Pool state at the time: `slot0` tick ≈ **-301484**, oracle cardinality **240**, liquidity ≈ **1.48e18**, reserves ≈ **5.19e24** WHSK + **4.20e11** USDT raw. `observe([3600,0])` and `observe([86400,0])` both succeeded. TWAP-implied price was about **0.0806–0.0808 USDT per WHSK**.

The same four HSKSwap/WHSK addresses have **no code on testnet chain 133**. There is no verified public HSKSwap pool to point a testnet vault at, so execution was verified on a **mainnet fork** instead.

## Tests (all passing)

```bash
cd contracts
forge test                              # 22 tests, 0 fail (unit + 512-run fuzz)
HSK_FORK=1 forge test --match-contract Fork -vv
cd ../agent && npm test                 # 6 Node tests
npm run demo                            # scripted lifecycle on an Anvil mainnet fork
```

### Unit / fuzz (`test/SentinelVault.t.sol`)

22 / 22 passed, including:

- agent buy/sell inside caps
- `NotAgent`, `TradeTooLarge`, `MinOutTooLoose` (hallucinated `minOut = 0`), `Cooldown`, daily limit + UTC-day reset
- `PriceDeviation` when spot is flashed away from TWAP
- exposure cap, pause, owner-only admin, `BadPolicy`
- agent can only tighten a stop-loss (never loosen, never below the owner floor)
- permissionless keeper stop-loss still works while the vault is paused; a spot-only wick does **not** trigger
- exit `minOut` is TWAP-anchored (a sandwich-style spot crash makes the exit revert)
- take-profit, drawdown breaker, withdrawals do not trip the breaker
- fuzz: a successful agent trade never exceeds caps or the slippage floor (512 runs)
- fuzz: `PriceLib.meanTick` rounds toward negative infinity (512 runs)

### Mainnet-fork lifecycle (`test/SentinelVault.fork.t.sol`)

Passed against the **real** HSKSwap WHSK/USDT pool (`HSK_FORK=1`, RPC `https://mainnet.hsk.xyz`). Representative log:

- live spot **80478**, TWAP **80792** (USDT raw / 1 WHSK)
- vault NAV after funding ≈ **2,419.80 USDT**
- agent bought **619.305** WHSK for 50 USDT
- a 150 USDT trade reverted on the on-chain cap
- a 400k WHSK dump moved spot to **69441** while TWAP stayed ~**80776**; the agent's next buy reverted (`PriceDeviation`)
- after one 600s TWAP window, a keeper `triggerExit()` sold **20,619.305** WHSK for **1,422.41 USDT**
- NAV after exit ≈ **2,176.37 USDT**; breaker not tripped on that path

### Agent unit tests (`agent/test/strategy.test.js`)

6 / 6 passed: tick→price conversion matches the live market (~0.08 USDT/WHSK), flat market holds, spread-outside-fee buys and is capped, in-band spread holds, downtrend sells, exposure target blocks further buys.

### Scripted demo (`npm run demo`)

Full 8-step demo against the real pool on a local fork, captured in `/tmp/demo2.log` on 2026-11-25. Highlights (Anvil accounts, not live funds):

1. Vault deployed at the CREATE address `0x38a024C0b412B9d1db8BC398140D00F5Af3093D4` on the fork (this is **not** a mainnet or testnet deployment).
2. Chat: "trade 40 USDT max", "be more aggressive", "check every 2 minutes", "what can you trade?", owner stop at −5% with a −10% floor, agent "stop 7%" reverted `OnlyTighten()`, "stop 3%" succeeded.
3. 60k WHSK dump: DEX −2.42% vs reference; same-block buy reverted `PriceDeviation(78805, 80752)`.
4. 10 minutes later the agent bought twice (~506 WHSK each), and each `reasonHash` verified against the local journal.
5. Rogue agent: `TradeTooLarge`, `MinOutTooLoose`, `NotOwner` on withdraw, `OnlyTighten` on a loosened stop.
6. 300k WHSK crash with the agent offline: a one-block wick did not fire the stop; the keeper retried as the TWAP crossed the stop and, after the anti-sandwich minOut cleared, executed stop-loss in tx `0xd756f1a1…` (gas 181,264), selling 2,011.84 WHSK for 141.52 USDT.
7. Final report: NAV 383.34 USDT, PnL −19.24 USDT (−4.78%) after the crash, 2 agent trades + 1 keeper exit, both journal hashes ✅ verified.

No profit is claimed. The −4.78% is the cost of buying a dislocation and then hitting a stop in a further dump — which is the risk system working.

## Testnet deployment — not broadcast

A fresh deployer key was generated into the gitignored file `.secrets/deployer.key`. The corresponding address is committed at [`deployments/testnet-deployer.address`](../deployments/testnet-deployer.address):

```
0x481496f054370FcBDe0Cb150992a8824C57129ad
```

On 2026-11-25 07:00 AM PT this address had **0 HSK** on chain 133. The official faucet is captcha-gated (and some faucet front ends are JS-only), so it was not used from this environment. No testnet transaction was sent.

The known mainnet HSKSwap addresses have no code on testnet, so a useful testnet deploy is the mock fixture in `script/DeployTestnetMocks.s.sol` (WHSK + USDT + a Uniswap-v3-shaped pool/router + SentinelVault). Run it after funding the deployer — see the checklist in [`SUBMISSION.md`](../SUBMISSION.md).

## Secrets

- `.secrets/`, `.env`, `*.key`, `keystore/`, `agent/state/`, `agent/journal/`, and `deployments/local-fork.json` are gitignored.
- The Anvil keys used in `npm run demo` are the well-known Foundry test keys, used only on a local fork.
- No private key is printed, committed, or stored under the user's accounts.
