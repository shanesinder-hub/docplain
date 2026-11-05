# Phase 1 — SPEC: 24/7 Autonomous Crypto Trading Agent

**Status:** DRAFT. Waiting for owner approval at Gate 1.
**Date:** 2026-11-05
**Rule for this document:** No performance number here comes from a backtest, because no backtest has run yet. Every figure has a label:

| Label | Meaning |
|---|---|
| **[MEASURED]** | Pulled from a live, documented API in this session. Raw data is in `docs/data/`. |
| **[VERIFY]** | A fact I'm fairly confident of from public docs but could not re-check from this sandbox, because exchange hosts are blocked here. Must be confirmed before Phase 3. |
| **[ASSUMPTION]** | A design choice or estimate. Can be changed. |
| **[LIT]** | Published research. It is a prior, not evidence that the edge works on our venue today. |

---

## 0. System overview (one paragraph)

The agent trades **spot crypto (BTC, ETH; SOL as an optional third asset), 24/7**. It is long-or-flat only, holds positions for days to weeks, and sizes by volatility targeting with a fractional-Kelly cap. A deterministic risk engine sits between every signal and the broker, and no model or signal can override it. The key fact from venue recon: **on Robinhood market-maker routing, the measured quoted spread was ~1.9% of mid on BTC, ETH and SOL [MEASURED, single snapshot]**. At that cost, any strategy that trades more than a handful of times a year is very likely dead before it starts. So the venue choice is the first gate decision, ahead of any strategy choice. The current regime is **bearish and volatile with a failed recovery**: BTC proxy −34% over 12 months, ~45% annualised vol, price below its 10-week average but above its 30-week average [MEASURED, IBIT proxy]. The candidate most likely to survive is a **slow trend / regime filter with volatility targeting**. Everything faster is expected to fail on costs, but it will still be tested and counted as a trial, so we don't fool ourselves by quietly dropping it.

---

## 1. Market and venue

### 1.1 Asset class
Spot crypto, USD-quoted. It's the only liquid asset class that trades 24/7, which is the brief. Equities and ETFs (e.g. IBIT) trade fewer hours, so they are used only as regime proxies.

### 1.2 Venue options (Gate 1 decision)

| | **A. Robinhood Crypto** | **B. Kraken Pro (spot)** | **C. Coinbase Advanced (spot)** |
|---|---|---|---|
| API | Robinhood Crypto Trading API (REST, Ed25519-signed keys) [VERIFY] | Kraken REST + WebSocket v2 [VERIFY] | Coinbase Advanced Trade REST + WebSocket [VERIFY] |
| Explicit fee | None. Cost is in the spread [VERIFY] | Lowest tier ~0.25% maker / 0.40% taker [VERIFY] | Lowest tier roughly 0.4–0.6% maker / 0.6–1.2% taker [VERIFY] |
| Quoted spread BTC | **1.89% of mid** [MEASURED, 03:00 ET, MM routing] | Typically ~0.01% on BTC-USD [VERIFY] | Typically ~0.01% on BTC-USD [VERIFY] |
| Est. round-trip cost, small taker order | **~1.9%** | **~0.8–0.9%** taker; ~0.5% maker [ASSUMPTION from fee tier] | **~1.2–2.4%** taker at lowest tier [ASSUMPTION] |
| Min order | Per pair. `get_currency_pairs` exposes `min_order_size` and increments [MEASURED] | Per pair, e.g. BTC 0.00005 [VERIFY] | Per pair [VERIFY] |
| Rate limits | ~100 req/min, burst 300 [VERIFY] | Counter-decay model [VERIFY] | Per-endpoint, ~30 req/s private [VERIFY] |
| Historical OHLCV via API | **No** (quotes and orders only) [VERIFY] | Yes (OHLC endpoint, limited depth) plus downloadable trade history [VERIFY] | Yes (candles endpoint) [VERIFY] |
| Shorting / perps for US retail | No | No (spot); US derivatives are separate [VERIFY] | Limited US futures via a separate entity [VERIFY] |
| Funding / OI data | N/A | N/A on spot | N/A on spot |
| Already connected in this workspace | **Yes** (read-only quotes verified) | No | No |
| Human trade-approval mode | Yes. Robinhood exposes a per-account trade-approval setting [MEASURED: tool exists] | Not native; we build it | Not native; we build it |

**Recommendation [ASSUMPTION]:**
- Do **research and paper trading** with exchange-grade historical data (Kraken or Coinbase candles/trades) plus a Robinhood quote logger that measures the real spread over ≥7 days.
- Pick the **live venue only after the spread log exists**. If Robinhood's median spread stays above ~0.5%, live trading should go to Kraken (B), or the strategy must trade ≤ ~4 round trips a year.
- The agent never gets withdrawal or transfer permissions on any venue.

### 1.3 Trading hours, latency
- 24/7/365. There is no exchange close, but maintenance windows happen [VERIFY per venue].
- The strategy is daily-bar. Latency of seconds to minutes does not matter. **Data freshness and order-state correctness do.** We do not compete on speed. Anyone who does would beat us.

### 1.4 Current regime [MEASURED, IBIT weekly proxy, 2025-10-27 → 2026-10-26]

| Indicator | Reading | Interpretation |
|---|---|---|
| Trend | −33.7% over 12 months; −30% from window high. Last 43.36 vs SMA10w 45.62 and SMA30w 41.34 | Long-term down. A Feb–Jun crash, an Aug–Sep rebound, rolling over again now. Mixed/choppy, the worst case for trend-following (whipsaws). |
| Volatility | 45% annualised (full year), 46.7% (last 13 weeks) | High. Vol targeting will cut exposure to roughly 0.3–0.45× of capital at a 15–20% target. |
| Liquidity | BTC/ETH spot deep on major exchanges; retail broker spread ~1.9% at 03:00 ET [MEASURED] | Liquidity isn't the constraint. **Cost is.** |
| Funding rates / open interest | **Not measured.** Perp venues are unreachable from this sandbox | Gap. Phase 2 must source funding/OI (e.g. exchange public endpoints) and use them as *filters only*. We cannot trade perps (see 1.2). |
| Macro events | Not modelled in v1 | The calendar filter (FOMC, CPI) is an ablation test, not a default. Adding it untested would be one more curve-fit knob. |

### 1.5 When to trade / stay out [ASSUMPTION; each rule must earn its place in validation]
- **Trade:** a trend signal is on, data is fresh, the venue is healthy, and the spread is below the configured ceiling.
- **Stay flat when any of these holds:**
  - stale or invalid data;
  - spread > 2× its 30-day median;
  - the exchange status endpoint is degraded;
  - daily loss or drawdown limit is hit;
  - the API error budget is exhausted;
  - the pair is halted in the account's region. `get_currency_pairs` exposes `halted` and `halted_regions` [MEASURED]. Several pairs were halted in NY at capture time.

---

## 2. Candidate strategies (pre-registered before any data is seen)

Every candidate below is counted as a trial, and so is every variant of it. The full trial count goes into the Deflated Sharpe computation (§3.5). All candidates use a **signal → target-position** interface. Execution is a separate module (§4).

### S1. Time-series trend (long/flat), daily, BTC + ETH
- **Edge:** Crypto returns show time-series momentum at multi-week horizons. Slow-moving capital, under-reaction to information, and herding make trends persist [LIT: Moskowitz, Ooi & Pedersen 2012 (TSMOM); Liu & Tsyvinski 2021 (crypto momentum)].
- **Other side:** Mean-reversion and value buyers early in a trend; forced or late sellers in drawdowns; the trade also captures what discretionary holders give up by not cutting exposure.
- **Entry:** Close > SMA(N) **and** N-day return > 0, evaluated once a day at 00:00 UTC on the *completed* bar.
- **Exit:** Either condition fails at the daily close.
- **Stop:** Catastrophe stop only: −3 × ATR(20) from entry, checked intraday. The real stop is the signal exit plus portfolio limits.
- **Holding period:** Weeks. **Frequency:** ~4–12 round trips per asset per year [ASSUMPTION, will be measured].
- **Grid (counted):** N ∈ {50, 75, 100, 125, 150, 200} = 6 variants.
- **Why it might persist:** It's a risk-transfer and behavioural premium, not an information edge. It's well known and partly arbitraged, so we expect *modest* Sharpe, and it does badly in chop. That's exactly the current regime.

### S2. Donchian breakout (long/flat), daily
- **Edge:** Same family as S1, with breakout entry. It enters later but has fewer false starts [LIT: classic CTA literature].
- **Entry:** Close > highest high of the last N days. **Exit:** close < lowest low of the last N/2 days. **Stop:** as S1.
- **Grid:** N ∈ {20, 40, 55, 80, 100} = 5 variants. **Frequency:** ~3–8 round trips per asset per year [ASSUMPTION].
- **Note:** Highly correlated with S1. If both pass, deploy only one, because two copies of the same bet are not diversification.

### S3. Volatility-targeted hold with a regime filter (benchmark-plus)
- **Edge:** Collects the crypto beta premium while cutting exposure when realised vol spikes. Vol clusters, and high-vol periods have historically had worse risk-adjusted returns [LIT: Moreira & Muir 2017, "Volatility-Managed Portfolios", for equities; crypto evidence is weaker].
- **Other side:** No direct counterparty. It's a risk-premium harvest. This candidate partly serves as a baseline.
- **Rules:** Target weight = min(cap, σ_target / σ_realised(30d)). Rebalance only when |target − current| > band (band is chosen to minimise turnover at our cost level).
- **Grid:** σ_target ∈ {15%, 20%, 30%} × band ∈ {10%, 25%} = 6 variants.
- **Risk:** It's mostly long beta. In a −34% year it loses money with less pain. It must beat buy-and-hold *risk-adjusted after costs* or it adds nothing.

### S4. Cross-sectional momentum, top-N coins, weekly
- **Edge:** Recent winners keep outperforming losers among liquid coins [LIT: Liu, Tsyvinski & Wu 2022].
- **Rules:** Each week, rank the top-20 coins by market cap on 4-week returns. Hold the top 3 long. There is no short leg, because spot accounts can't short.
- **Grid:** lookback ∈ {2, 4, 8} weeks × hold count ∈ {3, 5} = 6 variants.
- **Expected problems:**
  - Survivorship bias. The coin universe must be point-in-time, including delisted and dead coins, and that data is hard to get.
  - Turnover of ~50–100% a week, which means **~50–100 round trips a year → cost drag of roughly 50–190% a year at 1.9%** [arithmetic]. Expected to be rejected on any retail venue.

### S5. Short-term mean reversion, hourly (RSI-2 style)
- **Edge:** Intraday overshoots from liquidations and stop cascades revert. **Other side:** forced liquidations and panic sellers.
- **Rules:** Buy when hourly RSI(2) < 10 and price > SMA(200h). Exit when RSI(2) > 70 or after 24h.
- **Grid:** thresholds {5, 10, 15} × exits {60, 70} = 6 variants.
- **Expected verdict: reject on cost.** Each round trip must clear ~1.9% (Robinhood) or ~0.8% (Kraken taker) before it earns anything. The edge from hourly reversion is usually a fraction of a percent per trade [ASSUMPTION, to be measured]. It still gets tested and counted.

### S6. Funding-rate carry / basis (delta-neutral)
- **Edge:** Perp funding is persistently positive in bull phases because leveraged longs pay to hold. Short perp + long spot collects it.
- **Verdict: not implementable on the chosen venues.** It needs a perp short that US retail cannot access on A, B or C [VERIFY]. **It is not counted as a trial**, because no data is touched. Funding is used only as a **crowding filter** for S1 (an ablation trial).

### Benchmarks (not trials, always reported)
Cash (0%), buy-and-hold BTC, buy-and-hold 50/50 BTC/ETH with monthly rebalancing.

**Pre-registered trial count:** S1 6 + S2 5 + S3 6 + S4 6 + S5 6 = **29 variants**, plus any ablations (funding filter, macro calendar filter, each +1 per variant they touch). The count is logged in `research/trials.jsonl`, append-only.

---

## 3. Data and validation protocol

### 3.1 Data
- **Bars:** Daily and hourly OHLCV for BTC-USD and ETH-USD from an exchange source (Kraken/Coinbase), 2017-01 → present. Each bar is stamped by its **close time**. A signal computed on bar *t* can only fill at the **open of bar t+1 or later**.
- **Spread/cost:** Robinhood quote logger (bid/ask every 60s for ≥7 days, then continuous) → an empirical cost model by hour of day.
- **Universe for S4:** point-in-time top-20 list, including dead coins. If we can't get this, **S4 is untestable and rejected**, rather than tested on a survivor-biased set.
- **Data checks (tests):** monotonic timestamps, no duplicate bars, gap detection, OHLC consistency (L ≤ O,C ≤ H), outlier flags (>8σ moves cross-checked against a second source).

### 3.2 Splits (by time, never random)
- **Development:** 2017-01-01 → 2022-12-31. This covers a full bull/bear cycle including the 2018 and 2022 crashes.
- **Validation (walk-forward):** expanding window, re-fit annually, 2019 → 2022 out-of-sample folds.
- **Held-out test:** 2023-01-01 → 2026-10-31. **Opened once**, only for strategies that pass on development data. Results are reported whatever they show.

### 3.3 Cost model
- **Base:** measured median spread/2 per side + venue fee + slippage of 0.05% (daily-bar market orders at small size) [ASSUMPTION].
- **Stress:** 2× and 3× base cost. **A strategy must keep Sharpe > 0 at 2× cost to pass.**

### 3.4 Robustness gates (all must pass)
1. **Parameter plateau:** At least 60% of the grid neighbours of the chosen setting have Sharpe ≥ 50% of the best. A single spike means rejection.
2. **Both assets:** It works on BTC *and* ETH separately. Better on one is fine; negative on one means rejection.
3. **Sub-period stability:** Positive in at least 2 of 3 regimes (2017–19, 2020–22, 2023–26 held-out).
4. **Deflated Sharpe Ratio** (Bailey & López de Prado 2014) > 0.95 using the full trial count, **or** honest disclosure that the result isn't significant. With few trades a year, it may well not be.
5. **Beats the benchmark** on Sharpe *and* max drawdown after costs, or offers clearly better drawdown at comparable Sharpe.
6. **Minimum trade count:** ≥ 30 round trips across the full sample per asset. Below that, the stats are anecdotes.

### 3.5 Reported metrics (per variant, per split)
Sharpe (annualised, daily returns, 365-day year), Sortino, CAGR, max drawdown, drawdown duration, win rate, profit factor, number of trades, average trade return, exposure %, turnover, cost drag, Sharpe at 1×/2×/3× cost, deflated Sharpe.

---

## 4. Execution and risk (hard rules, enforced in code)

### 4.1 Architecture principle
`Signal → Sizer → RiskGate → OrderManager → Broker`.
- The **RiskGate is pure, deterministic code** with no ML and no LLM.
- It can only **shrink or reject** an order, never enlarge one.
- An LLM may only read logs and write reports. It has no path to the order API.

### 4.2 Sizing
- **Volatility targeting:** w = σ_target / σ̂, where σ̂ is EWMA vol of daily returns (half-life 20 days). σ_target = **15% annualised** at launch [ASSUMPTION].
- **Kelly cap:** w ≤ 0.25 × Kelly, with Kelly = μ̂/σ̂² estimated from held-out results, then **shrunk by 50%** for estimation error. The final weight is the minimum of the vol-target weight, the Kelly cap and the hard caps.
- **Never full Kelly. Never leverage** (spot only, w ≤ 1.0 per asset by construction).

### 4.3 Hard limits [ASSUMPTION: defaults, owner sets final numbers at Gate 1]

| Limit | Paper | Live stage 1 |
|---|---|---|
| Max capital allocated to the agent | n/a | **Owner-set; suggest ≤ $500** |
| Max position per asset | 50% of agent equity | 50% |
| Max gross exposure | 100% | 100% |
| Max daily loss (from day-start equity, UTC) | 3% → flatten + halt until next UTC day | 3% |
| Max drawdown (from high-water mark) | 15% → flatten + **halt until human re-enables** | 15% |
| Stale data | Quote > 60s old or daily bar > 26h old → no new orders | same |
| Spread ceiling | > 2× 30-day median, or > absolute cap → no orders | same |
| API errors | 5 consecutive, or 20 per rolling hour → halt + alert | same |
| Order sanity | Notional ≤ max position; price within 2% of mark for limits; min size and increments from the pair spec | same |
| Orders per day | ≤ 10 | ≤ 10 |

### 4.4 Kill switch
- `agent kill`, a file flag, or Telegram/email command → cancel all open orders → market-sell all positions to USD → halt.
- This is idempotent and safe to repeat.
- It is tested against the paper broker and a mocked broker that returns errors and partial fills.
- **Authority:** Flattening is the only action the agent may take without per-trade approval, and only if the owner pre-authorises it at Gate 1. **The agent has no ability to withdraw, transfer or deposit funds, on any venue, ever.**

### 4.5 Human approval
- **Paper:** fully autonomous.
- **Live stage 1:** every order needs owner approval. On Robinhood this uses the account's trade-approval setting; elsewhere it's an approval queue we build.
- Autonomy can be loosened only by an explicit Gate decision after ≥ 60 days of live-approved trading matches paper within tolerance.

### 4.6 Logging
An append-only JSONL decision log. Each tick records inputs (bar hash, quote, vol estimate), signal, target, risk-gate verdict with reasons, order request/response, fill, and P&L. A daily reconciliation compares broker positions with internal state, and any mismatch halts the agent.

---

## 5. Bear case — how each strategy breaks

| Risk | Where it bites | Mitigation / test |
|---|---|---|
| **Cost** | Everything. At 1.9% round trip, S4/S5 are dead, and S1 at 12 trades a year loses ~23%/yr to costs | Measured spread log; 2×/3× cost stress; venue gate |
| **Overfitting** | Grid choice; filters added after looking at results | Pre-registered grid; trial count; DSR; plateau test; held-out test opened once |
| **Look-ahead** | Using bar *t* close to fill at bar *t* close; vol estimated with the current bar | Fill at t+1 open; a unit test that shifting data by +1 bar *breaks* results (canary) |
| **Survivorship** | S4 universe | Point-in-time universe or reject S4 |
| **Regime dependence** | Trend dies in chop. **Chop is the current regime** | Sub-period gate; live chop-loss tolerance (kill criteria) |
| **Crowding** | Trend is the most crowded systematic trade in crypto; crowded unwinds gap down | Funding/OI as an ablation filter; catastrophe stop; small size |
| **Liquidity traps** | Weekend/holiday gaps; broker spread blows out in crashes (exactly when we exit) | Spread ceiling, but a trend exit *must* still happen. The rule: if the spread ceiling blocks an exit for more than 6h, alert the human |
| **Gap risk** | Crypto can drop 10–20% intraday (Feb 2026: IBIT weekly low 35.3 vs open 44.25 [MEASURED]) | Position caps; vol targeting; never leverage |
| **Infrastructure SPOF** | Single VM, single venue, single data feed, single API key | Watchdog + heartbeat alerting; secondary price source cross-check; state rebuilt from the broker on restart; the kill switch works without the strategy process |
| **Broker risk** | Venue outage, account restriction, regional halts | Halt-aware tradability check; human alert; never hold more than the agent allocation on the venue |
| **Model/LLM risk** | LLM hallucinating an order | No code path from the LLM to the order API (enforced by module boundary + test) |

---

## 6. Kill criteria (automatic, live)

Any of these → flatten + halt + alert. The human must re-enable.
1. Drawdown from high-water mark > **15%**, or > 1.5× the held-out max DD scaled to current vol target, whichever is smaller.
2. Rolling 90-day realised Sharpe < **−1.0** after ≥ 10 round trips. The result is incompatible with the backtest distribution at roughly 95% (exact threshold computed from the bootstrap in Phase 4).
3. Realised cost per trade > **2×** modeled for 5 consecutive trades. The edge assumption is broken.
4. Live vs paper-shadow divergence: position mismatch for > 1 bar, or cumulative P&L gap > 3% of equity.
5. Reconciliation mismatch between broker and internal state.
6. Stale-data or API-error halt that repeats 3 times in 24h.

## 7. Monitoring metrics
Equity, exposure, and drawdown vs limits; signal state per asset; fill price vs mark (realised slippage); spread vs 30-day median; data age; API error rate; heartbeat age; daily reconciliation status; trial-count ledger; live Sharpe vs backtest confidence band.

---

## 8. Comparison table (pre-validation)

**No backtest has run. The Sharpe / Max DD / Trades columns are deliberately empty until Phase 4.** Cost sensitivity is shown as arithmetic: annual cost drag ≈ round trips per year × round-trip cost.

| Strategy | Edge | Market | Timeframe | Sharpe | Max DD | Trades | Cost sensitivity (drag/yr @1.9% RH / ~0.85% Kraken taker) | Prior verdict |
|---|---|---|---|---|---|---|---|---|
| S1 TS trend | TSMOM / under-reaction | BTC, ETH spot | Daily, weeks hold | *untested* | *untested* | *est. 4–12/yr/asset* | 8–23% / 3–10% | **Lead candidate.** Venue-dependent |
| S2 Donchian | Breakout trend | BTC, ETH spot | Daily | *untested* | *untested* | *est. 3–8/yr/asset* | 6–15% / 3–7% | Candidate. Deploy at most one of S1/S2 |
| S3 Vol-target hold | Vol-managed beta | BTC, ETH spot | Daily, banded rebal | *untested* | *untested* | *rebalances, est. 6–20/yr* (partial size) | low–moderate (partial-size trades) | Candidate / baseline |
| S4 XS momentum | Winners keep winning | Top-20 coins | Weekly | *untested* | *untested* | *est. 50–100/yr* | 95–190% / 40–85% | **Expected reject** (cost, survivorship) |
| S5 Hourly MR | Liquidation overshoot | BTC, ETH | Hourly | *untested* | *untested* | *est. 100+/yr* | >190% / >85% | **Expected reject** (cost) |
| S6 Funding carry | Leverage demand | Perps + spot | 8h funding | n/a | n/a | n/a | n/a | **Not implementable** on venue; filter only |

---

## 9. AgenKit build plan

> I could not reach agenkit.xyz from this sandbox, so I haven't verified AgenKit's actual CLI or file conventions. The phases below follow the brief (spec → architecture → plan → test-first build → review → ship) as gated documents in `docs/`. Once you confirm how AgenKit expects artifacts to be laid out, I'll map them onto it.

| Phase | Deliverable | Gate |
|---|---|---|
| 1 Spec | This document | **G1: owner approves venue, limits, candidate list** |
| 2 Architecture | `docs/02-ARCHITECTURE.md`: module boundaries, data flow, failure modes, state machine | G2 |
| 3 Plan | `docs/03-PLAN.md`: ordered tickets, each with acceptance tests | G3 |
| 4 Build + research (TDD) | Risk engine → data layer → backtester → validation runs → results report with real numbers | G4: owner reviews the backtest report and picks what (if anything) deploys |
| 5 Review | Adversarial review: code review, a look-ahead canary, a cost-stress replay | G5 |
| 6 Ship (paper) | ≥ 30 days of paper trading with a shadow cost model | G6: go/no-go for live stage 1 (smallest size, every order human-approved) |

### Repo structure (proposed)
```
trading-agent/
  pyproject.toml
  config/{paper.yaml, live.yaml, limits.yaml}
  agent/
    risk/        gate.py limits.py killswitch.py      # first module, pure functions
    data/        feeds.py validate.py store.py spread_logger.py
    signals/     trend.py donchian.py voltarget.py     # signal -> target weight only
    sizing/      vol_target.py kelly_cap.py
    execution/   order_manager.py brokers/{paper.py, robinhood.py, kraken.py}
    ops/         heartbeat.py reconcile.py alerts.py decision_log.py
    run.py
  research/
    backtest.py costs.py metrics.py dsr.py walkforward.py
    trials.jsonl          # append-only trial ledger
    reports/
  tests/
    unit/ (risk, sizing, signals, metrics)
    property/ (hypothesis: risk gate never increases size, never exceeds caps)
    integration/ (paper broker, mocked broker faults: timeouts, partial fills, 429s)
    leakage/ (look-ahead canary, timestamp alignment)
  docs/ 01-SPEC.md 02-ARCHITECTURE.md ...
```

### Test suite highlights
- **Risk gate properties:**
  - output size ≤ input size;
  - never exceeds per-asset or gross caps;
  - rejects when data is stale;
  - rejects after the error budget is spent;
  - daily-loss and drawdown halts latch until the reset condition.
- **Kill switch:** flattens from any state, works with the broker returning errors, is idempotent.
- **Leakage canary:** a strategy fed future-shifted data must show an implausibly high Sharpe (that proves the harness *can* detect leakage), and the real pipeline must not.
- **Metrics:** Sharpe, max DD, profit factor and DSR checked against hand-computed fixtures.
- **Reconciliation:** an injected position mismatch causes a halt.

### First module to build
`agent/risk/` (RiskGate + limits + kill switch), test-first. It doesn't depend on any strategy decision, it's the piece that keeps capital alive, and every later module has to pass through it.

### Command to start paper trading (after G6; **does not exist yet**)
```
python -m agent.run --mode paper --config config/paper.yaml
```

---

## 10. Open decisions for Gate 1
1. **Venue for live (later):** Robinhood (connected, but ~1.9% measured spread) vs Kraken/Coinbase (lower cost, new keys). Research data source: OK to use Kraken/Coinbase public candles?
2. **Limits in §4.3:** confirm or change, especially max capital for live stage 1.
3. **Kill-switch authority:** may the agent flatten without per-trade approval when a kill criterion fires? (Recommended: yes. Flattening reduces risk.)
4. **Candidate list:** approve S1–S5 for testing (S6 excluded)?
5. **Repo location:** this lives in `trading-agent/` inside `docplain`, which is an unrelated website repo. A dedicated repo would be cleaner.

---

## HOW COULD THIS SYSTEM FAIL?

In priority order. Survival comes before returns.

1. **Costs eat the edge.** This is the weakest point, and it's already measured, not hypothetical: 1.9% spread on the connected venue. A slow trend system with a real but modest edge (literature-level Sharpe ~0.5–1.0 *before* costs) can go to zero or negative after 8–23%/yr of drag. *Survival rule:* no live capital until measured live cost is below the level at which the held-out backtest still has Sharpe > 0 at 2× cost.
2. **There is no edge left.** Crypto trend-following is public, crowded and run by funds with better execution. The literature's historical edge may have been arbitraged away since 2021, so held-out 2023–26 is the honest test. *Accepted outcome:* if nothing passes Gate 4, **the correct deliverable is "deploy nothing" or "deploy S3/buy-and-hold at a vol target"**, not a looser filter.
3. **The current regime is chop.** Trend systems lose steadily in sideways markets. A strategy can be valid and still bleed through the first 3–6 months live. The kill criteria must be set from the backtest's *own* chop periods, or we'll either kill a good strategy or ride a broken one.
4. **Too few trades to know.** ~10 trades a year per asset means years before live results statistically confirm or deny the edge. The kill criteria therefore lean on risk limits and cost/behaviour divergence, not on P&L significance.
5. **Data/feed failure.** A stale feed means we trade on old prices; a bad tick triggers a false signal. *Mitigations:* staleness check, second-source cross-check, outlier rejection, no orders without fresh data. The worst case is a missed exit during a crash; that's handled by the catastrophe stop at the broker side where supported, plus a human alert.
6. **Exchange/broker failure.** Outage at the moment we need to exit; account restriction; regional halt; venue insolvency (crypto history includes this). *Mitigations:* small allocation, no idle balance beyond the agent allocation, halt-aware tradability checks, no withdrawals by the agent.
7. **Single-machine SPOF.** If the VM dies, positions are unmanaged. *Mitigations:* external heartbeat monitor that alerts on silence, state rebuilt from the broker on restart, and positions that are survivable unmanaged for days by design (no leverage, capped size).
8. **Bugs in the code that protects us.** A sign error in the risk gate is worse than no strategy. *Mitigations:* property-based tests, paper ≥ 30 days, human approval on every live order at stage 1.
9. **Me.** These assumptions are mine. The strongest temptation in Phase 4 will be to add filters after seeing results. Every one of them gets logged as a trial.
