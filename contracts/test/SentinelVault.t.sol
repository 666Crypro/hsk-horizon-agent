// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SentinelVault} from "../src/SentinelVault.sol";
import {PriceLib} from "../src/lib/PriceLib.sol";
import {MockERC20, MockPool, MockRouter} from "./mocks/Mocks.sol";

contract SentinelVaultTest is Test {
    MockERC20 whsk;
    MockERC20 usdt;
    MockPool pool;
    MockRouter router;
    SentinelVault vault;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address keeper = makeAddr("keeper");
    address rando = makeAddr("rando");

    int24 constant BASE_TICK = -301484; // ~0.0806 USDT per WHSK when WHSK is token0 (live HSK mainnet tick)
    bool baseIs0;

    function setUp() public {
        vm.warp(1_790_000_000);
        whsk = new MockERC20("Wrapped HSK", "WHSK", 18);
        usdt = new MockERC20("Tether USD", "USDT", 6);
        pool = new MockPool(address(whsk), address(usdt));
        baseIs0 = pool.token0() == address(whsk);
        _setPrice(0, 0);
        router = new MockRouter(pool);
        vault = new SentinelVault(owner, agent, address(pool), address(router), address(whsk), _policy());

        whsk.mint(owner, 10_000 ether);
        usdt.mint(owner, 1_000e6);
        vm.startPrank(owner);
        whsk.approve(address(vault), type(uint256).max);
        usdt.approve(address(vault), type(uint256).max);
        vault.deposit(5_000 ether, 600e6); // ~403 USDT of WHSK + 600 USDT
        vm.stopPrank();
    }

    function _policy() internal pure returns (SentinelVault.Policy memory) {
        return SentinelVault.Policy({
            maxTradeQuote: 100e6,
            dailyQuoteLimit: 250e6,
            maxSlippageBps: 100,
            maxTwapDeviationBps: 200,
            maxDrawdownBps: 1_000,
            maxBaseExposureBps: 7_000,
            twapWindow: 900,
            cooldown: 60
        });
    }

    /// @dev move price by `spotDelta`/`twapDelta` ticks (1 tick ~ 0.01%) in "WHSK gets more expensive" direction
    function _setPrice(int24 spotDelta, int24 twapDelta) internal {
        if (baseIs0) pool.setTicks(BASE_TICK + spotDelta, BASE_TICK + twapDelta);
        else pool.setTicks(-BASE_TICK - spotDelta, -BASE_TICK - twapDelta);
    }

    function _fairBuyOut(uint256 usdtIn) internal view returns (uint256) {
        (, uint256 twap) = vault.prices();
        return usdtIn * 1e18 / twap;
    }

    // ------------------------------------------------------------------ basics

    function test_PriceMatchesLiveMarket() public view {
        (uint256 spot, uint256 twap) = vault.prices();
        assertEq(spot, twap);
        // ~0.0806 USDT per WHSK
        assertGt(spot, 80_000);
        assertLt(spot, 81_500);
        assertApproxEqRel(vault.nav(), 600e6 + 5_000 * spot, 1e15);
    }

    function test_AgentBuyWithinLimits() public {
        uint256 fair = _fairBuyOut(50e6);
        bytes32 why = keccak256("momentum: 15m TWAP +0.8% vs 1h, confidence 0.62");
        vm.prank(agent);
        uint256 out = vault.trade(true, 50e6, fair * 9_950 / 10_000, why);
        assertGt(out, fair * 99 / 100);
        assertEq(vault.tradeCount(), 1);
        assertEq(vault.dayVolume(), 50e6);
        assertEq(usdt.balanceOf(address(vault)), 550e6);
    }

    function test_AgentSellWithinLimits() public {
        (, uint256 twap) = vault.prices();
        uint256 amt = 500 ether; // ~40 USDT
        uint256 fair = amt * twap / 1e18;
        vm.prank(agent);
        vault.trade(false, amt, fair * 99 / 100, bytes32(0));
        assertEq(whsk.balanceOf(address(vault)), 4_500 ether);
    }

    function test_RevertWhen_NotAgent() public {
        vm.prank(rando);
        vm.expectRevert(SentinelVault.NotAgent.selector);
        vault.trade(true, 1e6, 0, bytes32(0));
    }

    function test_RevertWhen_TradeTooLarge() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SentinelVault.TradeTooLarge.selector, 101e6, 100e6));
        vault.trade(true, 101e6, 0, bytes32(0));
    }

    function test_RevertWhen_MinOutTooLoose() public {
        // a hallucinating agent passes minOut = 0: refused, sandwich protection is not optional
        vm.prank(agent);
        vm.expectRevert();
        vault.trade(true, 10e6, 0, bytes32(0));
    }

    function test_RevertWhen_Cooldown() public {
        uint256 fair = _fairBuyOut(10e6);
        vm.startPrank(agent);
        vault.trade(true, 10e6, fair * 99 / 100, bytes32(0));
        vm.expectRevert(SentinelVault.Cooldown.selector);
        vault.trade(true, 10e6, fair * 99 / 100, bytes32(0));
        vm.warp(block.timestamp + 61);
        vault.trade(true, 10e6, fair * 99 / 100, bytes32(0));
        vm.stopPrank();
    }

    function test_DailyLimitAndReset() public {
        uint256 t = block.timestamp;
        vm.startPrank(agent);
        for (uint256 i; i < 2; i++) {
            vault.trade(true, 100e6, _fairBuyOut(100e6) * 99 / 100, bytes32(0));
            t += 61;
            vm.warp(t);
        }
        uint256 fair = _fairBuyOut(60e6);
        vm.expectRevert(abi.encodeWithSelector(SentinelVault.DailyLimit.selector, 260e6, 250e6));
        vault.trade(true, 60e6, fair * 99 / 100, bytes32(0));
        assertEq(vault.dailyRemaining(), 50e6);
        vm.warp(t + 1 days);
        assertEq(vault.dailyRemaining(), 250e6);
        vm.stopPrank();
    }

    function test_RevertWhen_SpotDeviatesFromTwap() public {
        // someone flash-pumps the pool +5% vs TWAP: agent refuses to buy into it
        _setPrice(500, 0);
        uint256 minOut = _fairBuyOut(10e6) * 99 / 100;
        vm.prank(agent);
        vm.expectRevert();
        vault.trade(true, 10e6, minOut, bytes32(0));
    }

    function test_RevertWhen_ExposureTooHigh() public {
        SentinelVault.Policy memory p = _policy();
        p.maxBaseExposureBps = 4_500; // currently ~40%
        vm.prank(owner);
        vault.setPolicy(p);
        uint256 minOut = _fairBuyOut(100e6) * 99 / 100;
        vm.prank(agent);
        vm.expectRevert();
        vault.trade(true, 100e6, minOut, bytes32(0));
    }

    function test_RevertWhen_Paused() public {
        vm.prank(owner);
        vault.setPaused(true);
        uint256 minOut = _fairBuyOut(10e6);
        vm.prank(agent);
        vm.expectRevert(SentinelVault.Paused.selector);
        vault.trade(true, 10e6, minOut, bytes32(0));
    }

    // ------------------------------------------------------------------ stops

    function test_AgentCanOnlyTightenStop() public {
        vm.prank(owner);
        vault.setStops(70_000, 0, 65_000);
        vm.startPrank(agent);
        vm.expectRevert(SentinelVault.OnlyTighten.selector);
        vault.tightenStopLoss(69_000);
        vault.tightenStopLoss(75_000);
        assertEq(vault.stopLossPrice(), 75_000);
        vm.stopPrank();
    }

    function test_KeeperTriggersStopLoss_EvenWhenPaused() public {
        vm.prank(owner);
        vault.setStops(76_000, 0, 70_000);
        vm.prank(owner);
        vault.setPaused(true);

        vm.prank(keeper);
        vm.expectRevert(SentinelVault.StopNotTriggered.selector);
        vault.triggerExit();

        // price falls ~7% and the TWAP catches up
        _setPrice(-700, -700);
        (bool hit,,) = vault.stopStatus();
        assertTrue(hit);
        vm.prank(keeper);
        uint256 out = vault.triggerExit();
        assertEq(whsk.balanceOf(address(vault)), 0);
        assertGt(out, 0);
        assertEq(vault.stopLossPrice(), 0);
    }

    function test_StopLossIgnoresSpotOnlyWick() public {
        vm.prank(owner);
        vault.setStops(76_000, 0, 70_000);
        // attacker pushes spot down 10% in one block; TWAP has not moved -> no trigger
        _setPrice(-1_000, 0);
        vm.prank(keeper);
        vm.expectRevert(SentinelVault.StopNotTriggered.selector);
        vault.triggerExit();
    }

    function test_ExitMinOutAnchoredToTwap() public {
        vm.prank(owner);
        vault.setStops(76_000, 0, 70_000);
        // TWAP is below stop but spot was pushed 5% lower still (sandwich attempt) -> exit swap reverts
        _setPrice(-1_200, -700);
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        vault.triggerExit();
    }

    function test_TakeProfit() public {
        vm.prank(agent);
        vault.setTakeProfit(85_000);
        _setPrice(600, 600);
        vm.prank(keeper);
        vault.triggerExit();
        assertEq(whsk.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------------ breaker

    function test_DrawdownBreakerHaltsAgent() public {
        // buy more base, then the market drops 25%
        uint256 minOut = _fairBuyOut(100e6) * 99 / 100;
        vm.prank(agent);
        vault.trade(true, 100e6, minOut, bytes32(0));
        _setPrice(-2_900, -2_900);
        vault.checkpoint(); // anyone can poke
        assertTrue(vault.breakerTripped());

        vm.warp(block.timestamp + 61);
        vm.prank(agent);
        vm.expectRevert(SentinelVault.BreakerTripped.selector);
        vault.trade(false, 10 ether, 0, bytes32(0));

        vm.prank(owner);
        vault.resetBreaker();
        assertFalse(vault.breakerTripped());
    }

    function test_WithdrawDoesNotTripBreaker() public {
        vm.prank(owner);
        vault.withdraw(owner, 2_500 ether, 300e6);
        vault.checkpoint();
        assertFalse(vault.breakerTripped());
        assertApproxEqRel(vault.highWaterMark(), vault.nav(), 1e12);
    }

    function test_OnlyOwnerAdmin() public {
        vm.startPrank(agent);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.withdraw(agent, 1, 0);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.setPolicy(_policy());
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.setAgent(agent);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.setStops(0, 0, 0);
        vm.stopPrank();
    }

    function test_RevertWhen_BadPolicy() public {
        SentinelVault.Policy memory p = _policy();
        p.maxSlippageBps = 5_000;
        vm.prank(owner);
        vm.expectRevert(SentinelVault.BadPolicy.selector);
        vault.setPolicy(p);
    }

    // ------------------------------------------------------------------ fuzz

    /// @notice whatever the agent sends, a successful trade never exceeds the caps or the slippage floor
    function testFuzz_AgentCannotEscapePolicy(
        bool buy,
        uint256 amountIn,
        uint256 minOut,
        int16 spotMove,
        uint16 haircut
    ) public {
        amountIn = buy ? bound(amountIn, 1, 600e6) : bound(amountIn, 1, 5_000 ether);
        _setPrice(int24(spotMove) % 400, 0);
        router.setHaircut(bound(haircut, 0, 500));
        (, uint256 twap) = vault.prices();
        uint256 navBefore = vault.nav();

        vm.prank(agent);
        try vault.trade(buy, amountIn, minOut, bytes32(0)) returns (uint256 out) {
            uint256 notional = buy ? amountIn : amountIn * twap / 1e18;
            uint256 fair = buy ? amountIn * 1e18 / twap : notional;
            assertLe(notional, 100e6);
            assertLe(vault.dayVolume(), 250e6);
            assertGe(out + 1, fair * 9_900 / 10_000);
            assertGe(vault.nav() * 10_000, navBefore * 9_800); // single trade can't wreck the vault
        } catch {}
    }

    function testFuzz_MeanTickRoundsDown(int24 tick, uint32 window) public pure {
        tick = int24(bound(tick, -887_272, 887_272));
        window = uint32(bound(window, 1, 7 days));
        int56 end = int56(tick) * int56(uint56(window));
        assertEq(PriceLib.meanTick(0, end, window), tick);
        if (tick > -887_272) assertEq(PriceLib.meanTick(0, end - 1, window), tick - 1);
    }
}
