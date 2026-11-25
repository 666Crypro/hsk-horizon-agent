// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {SentinelVault} from "../src/SentinelVault.sol";

/// @notice Deploy SentinelVault. Never put a private key in a file: sign with --ledger, --interactive
///         or an encrypted keystore (--account <name>).
///
/// HSK Chain mainnet (chain 177), HSKSwap WHSK/USDT 0.3%:
///   OWNER=0xYourColdWallet AGENT=0xAgentHotKey \
///   forge script script/Deploy.s.sol --rpc-url hsk_mainnet --broadcast --interactives 1 \
///     --verify --verifier blockscout --verifier-url https://hsk.blockscout.com/api/
contract Deploy is Script {
    function run() external returns (SentinelVault vault) {
        address owner = vm.envAddress("OWNER");
        address agent = vm.envAddress("AGENT");
        address pool = vm.envOr("POOL", address(0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC));
        address router = vm.envOr("ROUTER", address(0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3));
        address base = vm.envOr("BASE", address(0xB210D2120d57b758EE163cFfb43e73728c471Cf1));

        SentinelVault.Policy memory p = SentinelVault.Policy({
            maxTradeQuote: uint128(vm.envOr("MAX_TRADE_QUOTE", uint256(10e6))), // 10 USDT
            dailyQuoteLimit: uint128(vm.envOr("DAILY_LIMIT_QUOTE", uint256(50e6))), // 50 USDT
            maxSlippageBps: uint16(vm.envOr("MAX_SLIPPAGE_BPS", uint256(100))),
            maxTwapDeviationBps: uint16(vm.envOr("MAX_TWAP_DEV_BPS", uint256(150))),
            maxDrawdownBps: uint16(vm.envOr("MAX_DRAWDOWN_BPS", uint256(1_000))),
            maxBaseExposureBps: uint16(vm.envOr("MAX_EXPOSURE_BPS", uint256(7_000))),
            twapWindow: uint32(vm.envOr("TWAP_WINDOW", uint256(600))),
            cooldown: uint32(vm.envOr("COOLDOWN", uint256(60)))
        });

        vm.startBroadcast();
        vault = new SentinelVault(owner, agent, pool, router, base, p);
        vm.stopBroadcast();

        console2.log("SentinelVault:", address(vault));
        console2.log("chainId:", block.chainid);
        console2.log("block:", block.number);
    }
}
