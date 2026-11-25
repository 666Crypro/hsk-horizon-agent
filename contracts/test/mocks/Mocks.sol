// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PriceLib} from "../../src/lib/PriceLib.sol";

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// @notice Uniswap-v3-shaped pool with a settable spot tick and TWAP tick.
contract MockPool {
    address public token0;
    address public token1;
    uint24 public fee = 3000;
    int24 public spotTick;
    int24 public twapTick;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setTicks(int24 spot, int24 twap) external {
        spotTick = spot;
        twapTick = twap;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, spotTick, 0, 0, 0, 0, true);
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory cum, uint160[] memory spl) {
        cum = new int56[](ago.length);
        spl = new uint160[](ago.length);
        for (uint256 i; i < ago.length; i++) {
            cum[i] = -int56(twapTick) * int56(uint56(ago[i]));
        }
    }
}

/// @notice Router that fills at the pool's SPOT tick minus the 0.3% fee (and an optional extra haircut).
contract MockRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    MockPool public pool;
    uint256 public haircutBps;

    constructor(MockPool p) {
        pool = p;
    }

    function setHaircut(uint256 bps) external {
        haircutBps = bps;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = PriceLib.getQuoteAtTick(pool.spotTick(), uint128(p.amountIn), p.tokenIn, p.tokenOut);
        out = out * (1_000_000 - p.fee) / 1_000_000;
        out = out * (10_000 - haircutBps) / 10_000;
        require(out >= p.amountOutMinimum, "Too little received");
        MockERC20(p.tokenOut).mint(p.recipient, out);
    }
}
