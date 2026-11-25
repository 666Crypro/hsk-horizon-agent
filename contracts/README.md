# SentinelVault (Foundry)

Smart contracts for **HSK Sentinel**, the Track 1 (AI Agent Trading) entry for the HSK Chain Horizon Hackathon · Seoul.

See the [root README](../README.md) for architecture, addresses, and how to run the agent.

```bash
forge test                         # 22 unit + fuzz tests
HSK_FORK=1 forge test --match-contract Fork -vv   # real HSKSwap pool on a mainnet fork
OWNER=0x... AGENT=0x... forge script script/Deploy.s.sol --rpc-url hsk_mainnet --broadcast --interactives 1
```

Do not put a private key in a file or in the command line history if you can avoid it. Prefer `--interactives 1`, `--ledger`, or `cast wallet` keystores.
