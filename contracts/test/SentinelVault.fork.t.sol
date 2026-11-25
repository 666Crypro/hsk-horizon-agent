// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {SentinelVault} from "../src/SentinelVault.sol";
import {ISwapRouter02, IERC20Min} from "../src/interfaces/IUniswapV3.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Runs against the REAL HSKSwap WHSK/USDT pool on an HSK Chain mainnet fork.
///         `HSK_FORK=1 forge test --match-contract Fork -vv`
contract SentinelVaultForkTest is Test {
    address constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address constant POOL = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC; // WHSK/USDT 0.3%
    address constant ROUTER = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3; // HSKSwap SwapRouter02

    SentinelVault vault;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address keeper = makeAddr("keeper");
    address whale = makeAddr("whale");
    bool noFork;
    uint256 t0;

    function setUp() public {
        if (vm.envOr("HSK_FORK", uint256(0)) == 0) {
            noFork = true;
            return;
        }
        vm.createSelectFork(vm.envOr("HSK_RPC", string("https://mainnet.hsk.xyz")));
        t0 = block.timestamp;
        vault = new SentinelVault(
            owner,
            agent,
            POOL,
            ROUTER,
            WHSK,
            SentinelVault.Policy({
                maxTradeQuote: 100e6,
                dailyQuoteLimit: 500e6,
                maxSlippageBps: 100,
                maxTwapDeviationBps: 150,
                maxDrawdownBps: 1_500,
                maxBaseExposureBps: 8_000,
                twapWindow: 600,
                cooldown: 30
            })
        );
        // owner: wrap 30k HSK, swap 10k WHSK -> USDT on HSKSwap, deposit both
        vm.deal(owner, 30_000 ether);
        vm.startPrank(owner);
        IWETH(WHSK).deposit{value: 30_000 ether}();
        _routerSwap(owner, WHSK, USDT, 10_000 ether);
        IERC20Min(WHSK).approve(address(vault), type(uint256).max);
        IERC20Min(USDT).approve(address(vault), type(uint256).max);
        vault.deposit(20_000 ether, IERC20Min(USDT).balanceOf(owner));
        vm.stopPrank();
    }

    function _routerSwap(address who, address tIn, address tOut, uint256 amt) internal returns (uint256) {
        IERC20Min(tIn).approve(ROUTER, amt);
        return
            ISwapRouter02(ROUTER)
                .exactInputSingle(ISwapRouter02.ExactInputSingleParams(tIn, tOut, 3000, who, amt, 0, 0));
    }

    function test_Fork_FullLifecycle() public {
        if (noFork) return;
        (uint256 spot, uint256 twap) = vault.prices();
        console2.log("live spot  (USDT raw / WHSK):", spot);
        console2.log("live twap  (USDT raw / WHSK):", twap);
        console2.log("vault NAV  (USDT raw):       ", vault.nav());

        // 1) agent buys 50 USDT of WHSK on the real pool
        uint256 fair = 50e6 * 1e18 / twap;
        vm.prank(agent);
        uint256 got = vault.trade(true, 50e6, fair * 99 / 100, keccak256("fork-demo buy"));
        console2.log("agent bought WHSK (wei):     ", got);
        assertGt(got, fair * 99 / 100);

        // 2) over-limit trade refused by the contract, not by the agent
        vm.warp(t0 + 31);
        vm.prank(agent);
        vm.expectRevert();
        vault.trade(true, 150e6, 0, bytes32(0));

        // 3) owner arms a stop 3% under TWAP
        vm.prank(owner);
        vault.setStops(twap * 97 / 100, 0, twap * 90 / 100);

        // 4) whale dumps 400k WHSK -> spot crashes, TWAP lags
        vm.deal(whale, 400_000 ether);
        vm.startPrank(whale);
        IWETH(WHSK).deposit{value: 400_000 ether}();
        _routerSwap(whale, WHSK, USDT, 400_000 ether);
        vm.stopPrank();
        (uint256 spot2, uint256 twap2) = vault.prices();
        console2.log("after dump spot:             ", spot2);
        console2.log("after dump twap:             ", twap2);

        // agent cannot buy the wick: spot/TWAP deviation guard
        vm.warp(t0 + 62);
        uint256 f2 = 10e6 * 1e18 / twap2;
        vm.prank(agent);
        vm.expectRevert();
        vault.trade(true, 10e6, f2, bytes32(0));

        // 5) TWAP catches up after one window -> any keeper triggers the stop-loss
        vm.warp(t0 + 62 + 600);
        vm.roll(block.number + 300);
        (bool hit,, uint256 twap3) = vault.stopStatus();
        console2.log("twap after window:           ", twap3);
        assertTrue(hit);
        uint256 baseBefore = IERC20Min(WHSK).balanceOf(address(vault));
        vm.prank(keeper);
        uint256 out = vault.triggerExit();
        console2.log("stop-loss sold WHSK (wei):   ", baseBefore);
        console2.log("stop-loss received USDT raw: ", out);
        assertEq(IERC20Min(WHSK).balanceOf(address(vault)), 0);
        console2.log("NAV after exit (USDT raw):   ", vault.nav());
        console2.log("breaker tripped:             ", vault.breakerTripped());
    }
}
