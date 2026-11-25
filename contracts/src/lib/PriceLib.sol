// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import {TickMath} from "./TickMath.sol";
import {FullMath} from "./FullMath.sol";

/// @notice Price helpers (Uniswap v3 OracleLibrary.getQuoteAtTick, 0.8 port).
library PriceLib {
    /// @return quoteAmount amount of `quoteToken` received for `baseAmount` of `baseToken` at `tick`
    function getQuoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    /// @notice arithmetic mean tick over `window` seconds, rounded toward negative infinity
    function meanTick(int56 cumStart, int56 cumEnd, uint32 window) internal pure returns (int24 tick) {
        int56 delta = cumEnd - cumStart;
        tick = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;
    }
}
