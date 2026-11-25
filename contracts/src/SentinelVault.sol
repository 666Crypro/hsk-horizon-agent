// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Min, IUniswapV3PoolMin, ISwapRouter02} from "./interfaces/IUniswapV3.sol";
import {PriceLib} from "./lib/PriceLib.sol";
import {FullMath} from "./lib/FullMath.sol";

/// @title SentinelVault
/// @notice A risk-bounded vault that lets an AI agent trade one HSKSwap (Uniswap v3) pool on HSK Chain.
///         The human OWNER holds the funds and sets the risk policy. The AGENT is a hot key that can only
///         trade inside that policy. Every rule is enforced on-chain, so a buggy, hallucinating or
///         compromised agent can never exceed the limits:
///           - per-trade and per-UTC-day notional caps, trade cooldown
///           - minOut must be within `maxSlippageBps` of the pool TWAP (agent cannot pass a loose minOut)
///           - spot vs TWAP deviation guard (refuses to trade into a manipulated / flash-crashed pool)
///           - max base-asset exposure after a buy
///           - NAV drawdown circuit breaker (trips on high-water-mark drawdown, halts the agent)
///           - stop-loss / take-profit that ANYONE can trigger (keeper), priced off the TWAP,
///             so the exit still happens if the agent's server is down
///           - every agent trade carries `reasonHash` = keccak256 of the agent's decision record,
///             an on-chain, tamper-evident decision journal
contract SentinelVault {
    // ---------------------------------------------------------------- types
    struct Policy {
        uint128 maxTradeQuote; // max notional per trade, in quote raw units (e.g. USDT 6 dp)
        uint128 dailyQuoteLimit; // max gross notional per UTC day, quote raw
        uint16 maxSlippageBps; // minOut must be >= TWAP-implied out * (1 - this)
        uint16 maxTwapDeviationBps; // |spot - twap| / twap must be <= this to trade
        uint16 maxDrawdownBps; // NAV drop from high-water mark that trips the breaker
        uint16 maxBaseExposureBps; // base value / NAV after a buy must be <= this
        uint32 twapWindow; // seconds
        uint32 cooldown; // min seconds between agent trades
    }

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotAgent();
    error Paused();
    error BreakerTripped();
    error Cooldown();
    error TradeTooLarge(uint256 notional, uint256 cap);
    error DailyLimit(uint256 used, uint256 cap);
    error MinOutTooLoose(uint256 minOut, uint256 floor);
    error PriceDeviation(uint256 spot, uint256 twap);
    error ExposureTooHigh(uint256 exposureBps, uint256 cap);
    error BadPolicy();
    error StopNotTriggered();
    error OnlyTighten();
    error NothingToSell();
    error TransferFailed();
    error ZeroAddress();

    // ---------------------------------------------------------------- events
    event TradeExecuted(
        uint256 indexed id,
        bool indexed buyBase,
        uint256 amountIn,
        uint256 amountOut,
        uint256 twapPrice,
        uint256 navAfter,
        bytes32 reasonHash
    );
    event ExitTriggered(
        address indexed keeper, bool indexed stopLoss, uint256 baseSold, uint256 quoteOut, uint256 twapPrice
    );
    event PolicyUpdated(Policy policy);
    event StopsUpdated(address indexed by, uint256 stopLossPrice, uint256 takeProfitPrice);
    event AgentUpdated(address indexed agent);
    event PausedSet(bool paused);
    event BreakerSet(bool tripped, uint256 nav, uint256 highWaterMark);
    event Deposited(uint256 baseAmount, uint256 quoteAmount, uint256 navAfter);
    event Withdrawn(address indexed to, uint256 baseAmount, uint256 quoteAmount, uint256 navAfter);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ---------------------------------------------------------------- immutables
    IERC20Min public immutable base; // risk asset, e.g. WHSK
    IERC20Min public immutable quote; // quote asset, e.g. USDT
    IUniswapV3PoolMin public immutable pool;
    ISwapRouter02 public immutable router;
    uint24 public immutable poolFee;
    uint128 public immutable baseUnit; // 10 ** base.decimals()

    // ---------------------------------------------------------------- state
    address public owner;
    address public agent;
    Policy public policy;
    bool public paused;
    bool public breakerTripped;

    /// @dev prices are "quote raw per 1 whole base token" (e.g. USDT 6dp per 1 WHSK)
    uint256 public stopLossPrice; // 0 = disabled
    uint256 public takeProfitPrice; // 0 = disabled
    uint256 public ownerStopFloor; // agent may only tighten stop-loss at/above this

    uint256 public highWaterMark; // NAV in quote raw
    uint256 public lastTradeAt;
    uint256 public tradeCount;
    uint256 public currentDay;
    uint256 public dayVolume;

    uint256 private _lock = 1;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrancy");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address owner_, address agent_, address pool_, address router_, address base_, Policy memory policy_) {
        if (owner_ == address(0) || pool_ == address(0) || router_ == address(0) || base_ == address(0)) {
            revert ZeroAddress();
        }
        IUniswapV3PoolMin p = IUniswapV3PoolMin(pool_);
        address t0 = p.token0();
        address t1 = p.token1();
        require(base_ == t0 || base_ == t1, "base not in pool");
        owner = owner_;
        agent = agent_;
        pool = p;
        router = ISwapRouter02(router_);
        poolFee = p.fee();
        base = IERC20Min(base_);
        quote = IERC20Min(base_ == t0 ? t1 : t0);
        baseUnit = uint128(10 ** IERC20Min(base_).decimals());
        _setPolicy(policy_);
        emit OwnershipTransferred(address(0), owner_);
        emit AgentUpdated(agent_);
    }

    // ================================================================ views

    /// @notice spot and TWAP price, quote raw per 1 whole base token
    function prices() public view returns (uint256 spot, uint256 twap) {
        (, int24 spotTick,,,,,) = pool.slot0();
        uint32[] memory ago = new uint32[](2);
        ago[0] = policy.twapWindow;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        int24 twapTick = PriceLib.meanTick(cum[0], cum[1], policy.twapWindow);
        spot = PriceLib.getQuoteAtTick(spotTick, baseUnit, address(base), address(quote));
        twap = PriceLib.getQuoteAtTick(twapTick, baseUnit, address(base), address(quote));
    }

    /// @notice net asset value in quote raw units, base valued at TWAP
    function nav() public view returns (uint256) {
        (, uint256 twap) = prices();
        return _nav(twap);
    }

    function dailyRemaining() external view returns (uint256) {
        uint256 used = (block.timestamp / 1 days == currentDay) ? dayVolume : 0;
        return used >= policy.dailyQuoteLimit ? 0 : policy.dailyQuoteLimit - used;
    }

    function stopStatus() external view returns (bool stopHit, bool takeProfitHit, uint256 twap) {
        (, twap) = prices();
        stopHit = stopLossPrice != 0 && twap <= stopLossPrice;
        takeProfitHit = takeProfitPrice != 0 && twap >= takeProfitPrice;
    }

    // ================================================================ agent

    /// @notice Agent trade. All limits enforced here.
    /// @param buyBase true = spend quote to buy base; false = sell base for quote
    /// @param amountIn exact input amount (raw units of the input token)
    /// @param minOut agent's minimum output; must be at least the TWAP-implied floor
    /// @param reasonHash keccak256 of the agent's off-chain decision record (journal)
    function trade(bool buyBase, uint256 amountIn, uint256 minOut, bytes32 reasonHash)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != agent) revert NotAgent();
        if (amountIn == 0) revert NothingToSell();
        if (paused) revert Paused();
        if (breakerTripped) revert BreakerTripped();
        if (lastTradeAt != 0 && block.timestamp < lastTradeAt + policy.cooldown) revert Cooldown();

        (uint256 spot, uint256 twap) = prices();
        _checkDeviation(spot, twap);

        uint256 notional = buyBase ? amountIn : FullMath.mulDiv(amountIn, twap, baseUnit);
        if (notional > policy.maxTradeQuote) revert TradeTooLarge(notional, policy.maxTradeQuote);

        uint256 day = block.timestamp / 1 days;
        if (day != currentDay) {
            currentDay = day;
            dayVolume = 0;
        }
        if (dayVolume + notional > policy.dailyQuoteLimit) {
            revert DailyLimit(dayVolume + notional, policy.dailyQuoteLimit);
        }
        dayVolume += notional;

        uint256 fairOut = buyBase ? FullMath.mulDiv(amountIn, baseUnit, twap) : notional;
        uint256 floorOut = fairOut * (10_000 - policy.maxSlippageBps) / 10_000;
        if (minOut < floorOut) revert MinOutTooLoose(minOut, floorOut);

        amountOut = _swap(buyBase, amountIn, minOut);
        lastTradeAt = block.timestamp;
        uint256 id = ++tradeCount;

        uint256 navAfter = _nav(twap);
        if (buyBase && navAfter > 0) {
            uint256 exposure = FullMath.mulDiv(_baseValue(twap), 10_000, navAfter);
            if (exposure > policy.maxBaseExposureBps) revert ExposureTooHigh(exposure, policy.maxBaseExposureBps);
        }
        _checkpoint(navAfter);
        emit TradeExecuted(id, buyBase, amountIn, amountOut, twap, navAfter, reasonHash);
    }

    /// @notice agent may move the stop-loss UP only (never loosen), and never below the owner's floor
    function tightenStopLoss(uint256 newStop) external {
        if (msg.sender != agent && msg.sender != owner) revert NotAgent();
        if (newStop <= stopLossPrice || newStop < ownerStopFloor) revert OnlyTighten();
        stopLossPrice = newStop;
        emit StopsUpdated(msg.sender, stopLossPrice, takeProfitPrice);
    }

    /// @notice agent may set a take-profit level (only exits to quote, so it can only reduce risk)
    function setTakeProfit(uint256 newTakeProfit) external {
        if (msg.sender != agent && msg.sender != owner) revert NotAgent();
        takeProfitPrice = newTakeProfit;
        emit StopsUpdated(msg.sender, stopLossPrice, takeProfitPrice);
    }

    // ================================================================ keepers (permissionless)

    /// @notice Anyone may call when TWAP is at/below stop-loss or at/above take-profit.
    ///         Sells the entire base balance with a TWAP-anchored minOut. Works while paused
    ///         or after the breaker trips: exits are always allowed, entries are not.
    function triggerExit() external nonReentrant returns (uint256 quoteOut) {
        (, uint256 twap) = prices();
        bool stopHit = stopLossPrice != 0 && twap <= stopLossPrice;
        bool tpHit = takeProfitPrice != 0 && twap >= takeProfitPrice;
        if (!stopHit && !tpHit) revert StopNotTriggered();
        uint256 bal = base.balanceOf(address(this));
        if (bal == 0) revert NothingToSell();
        // Anti-sandwich: minOut is anchored to the TWAP, never to spot. Exits get 2x the normal slippage
        // budget. In a gap-down deeper than that the swap reverts, but the TWAP converges to spot within
        // `twapWindow`, so a keeper retry succeeds at the latest one window later.
        uint256 fairOut = FullMath.mulDiv(bal, twap, baseUnit);
        uint256 minOut = fairOut * (10_000 - 2 * uint256(policy.maxSlippageBps)) / 10_000;
        quoteOut = _swap(false, bal, minOut);
        if (stopHit) stopLossPrice = 0; // one-shot
        if (tpHit) takeProfitPrice = 0;
        emit ExitTriggered(msg.sender, stopHit, bal, quoteOut, twap);
        _checkpoint(_nav(twap));
    }

    /// @notice anyone may poke the drawdown breaker (e.g. a watcher during a crash)
    function checkpoint() external {
        _checkpoint(nav());
    }

    // ================================================================ owner

    function deposit(uint256 baseAmount, uint256 quoteAmount) external onlyOwner nonReentrant {
        if (baseAmount > 0) _pull(base, baseAmount);
        if (quoteAmount > 0) _pull(quote, quoteAmount);
        (, uint256 twap) = prices();
        uint256 n = _nav(twap);
        uint256 added = FullMath.mulDiv(baseAmount, twap, baseUnit) + quoteAmount;
        highWaterMark += added;
        if (highWaterMark < n) highWaterMark = n;
        emit Deposited(baseAmount, quoteAmount, n);
    }

    function withdraw(address to, uint256 baseAmount, uint256 quoteAmount) external onlyOwner nonReentrant {
        uint256 before = nav();
        if (baseAmount > 0) _push(base, to, baseAmount);
        if (quoteAmount > 0) _push(quote, to, quoteAmount);
        uint256 afterNav = nav();
        // scale HWM so withdrawals are not mistaken for drawdown
        highWaterMark = before == 0 ? 0 : FullMath.mulDiv(highWaterMark, afterNav, before);
        emit Withdrawn(to, baseAmount, quoteAmount, afterNav);
    }

    function setPolicy(Policy calldata p) external onlyOwner {
        _setPolicy(p);
    }

    function setAgent(address a) external onlyOwner {
        agent = a;
        emit AgentUpdated(a);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice owner sets stops freely, plus the floor below which the agent can never move the stop
    function setStops(uint256 stopLoss, uint256 takeProfit, uint256 floor_) external onlyOwner {
        stopLossPrice = stopLoss;
        takeProfitPrice = takeProfit;
        ownerStopFloor = floor_;
        emit StopsUpdated(msg.sender, stopLoss, takeProfit);
    }

    /// @notice reset breaker and re-base the high-water mark to the current NAV
    function resetBreaker() external onlyOwner {
        breakerTripped = false;
        highWaterMark = nav();
        emit BreakerSet(false, highWaterMark, highWaterMark);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    // ================================================================ internal

    function _setPolicy(Policy memory p) internal {
        if (
            p.maxSlippageBps > 1_000 || p.maxTwapDeviationBps > 2_000 || p.maxDrawdownBps > 10_000
                || p.maxBaseExposureBps > 10_000 || p.twapWindow < 60 || p.maxTradeQuote > p.dailyQuoteLimit
        ) revert BadPolicy();
        policy = p;
        emit PolicyUpdated(p);
    }

    function _checkDeviation(uint256 spot, uint256 twap) internal view {
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        if (diff * 10_000 > twap * policy.maxTwapDeviationBps) revert PriceDeviation(spot, twap);
    }

    function _swap(bool buyBase, uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        IERC20Min tokenIn = buyBase ? quote : base;
        IERC20Min tokenOut = buyBase ? base : quote;
        _approve(tokenIn, address(router), amountIn);
        out = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        _approve(tokenIn, address(router), 0);
    }

    function _checkpoint(uint256 n) internal {
        if (n > highWaterMark) {
            highWaterMark = n;
        } else if (
            !breakerTripped && highWaterMark > 0 && n * 10_000 < highWaterMark * (10_000 - policy.maxDrawdownBps)
        ) {
            breakerTripped =
                true;
            emit BreakerSet(true, n, highWaterMark);
        }
    }

    function _baseValue(uint256 twap) internal view returns (uint256) {
        return FullMath.mulDiv(base.balanceOf(address(this)), twap, baseUnit);
    }

    function _nav(uint256 twap) internal view returns (uint256) {
        return _baseValue(twap) + quote.balanceOf(address(this));
    }

    function _approve(IERC20Min t, address spender, uint256 amt) internal {
        (bool ok, bytes memory data) = address(t).call(abi.encodeCall(IERC20Min.approve, (spender, amt)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _pull(IERC20Min t, uint256 amt) internal {
        (bool ok, bytes memory data) =
            address(t).call(abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), amt)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(IERC20Min t, address to, uint256 amt) internal {
        (bool ok, bytes memory data) = address(t).call(abi.encodeCall(IERC20Min.transfer, (to, amt)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
