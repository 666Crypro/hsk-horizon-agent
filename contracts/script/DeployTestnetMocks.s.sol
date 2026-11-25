// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {SentinelVault} from "../src/SentinelVault.sol";
import {MockERC20, MockPool, MockRouter} from "../test/mocks/Mocks.sol";

/// @notice Self-contained HSK testnet fixture: mock WHSK + USDT + a Uniswap-v3-shaped
///         pool/router + SentinelVault. Use this only because the mainnet HSKSwap
///         addresses have no code on chain 133.
///
///         Fund the gitignored deployer, then:
///           forge script script/DeployTestnetMocks.s.sol --rpc-url hsk_testnet --broadcast --private-key $PK
///
///         This is a demo fixture, not a production DEX.
contract DeployTestnetMocks is Script {
    int24 constant LIVE_TICK = -301484; // ~0.0806 USDT per WHSK, matching mainnet at time of writing

    function run() external {
        address owner = vm.envOr("OWNER", msg.sender);
        address agent = vm.envOr("AGENT", msg.sender);

        vm.startBroadcast();
        MockERC20 whsk = new MockERC20("Wrapped HSK (mock)", "WHSK", 18);
        MockERC20 usdt = new MockERC20("Tether USD (mock)", "USDT", 6);
        MockPool pool = new MockPool(address(whsk), address(usdt));
        pool.setTicks(LIVE_TICK, LIVE_TICK);
        MockRouter router = new MockRouter(pool);

        SentinelVault vault = new SentinelVault(
            owner,
            agent,
            address(pool),
            address(router),
            address(whsk),
            SentinelVault.Policy({
                maxTradeQuote: 10e6,
                dailyQuoteLimit: 50e6,
                maxSlippageBps: 100,
                maxTwapDeviationBps: 150,
                maxDrawdownBps: 1_000,
                maxBaseExposureBps: 7_000,
                twapWindow: 600,
                cooldown: 60
            })
        );

        // seed the owner so they can deposit without a DEX
        whsk.mint(owner, 2_000 ether);
        usdt.mint(owner, 200e6);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("WHSK (mock)", address(whsk));
        console2.log("USDT (mock)", address(usdt));
        console2.log("MockPool", address(pool));
        console2.log("MockRouter", address(router));
        console2.log("SentinelVault", address(vault));
        console2.log("owner", owner);
        console2.log("agent", agent);
    }
}
