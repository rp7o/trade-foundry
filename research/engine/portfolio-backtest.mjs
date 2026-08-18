// Vendored from the trading-strategy-engine project.
//
// Upstream shipped this as a CLI that read a JSON context on stdin and printed
// JSON on stdout. The simulation logic below is unchanged; only the entry and
// exit were rewritten so callers import and call it directly.
//
// This is the execution boundary shared by every strategy: given candles and a
// strategy module exporting proposeTrade(history), it simulates a multi-symbol
// portfolio and reports capital, trades, and risk diagnostics.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildAlignedIndex } from "./market-context.mjs";

export const SCHEMA_VERSION = "trading-strategy-engine.v1";

/**
 * Run a multi-symbol portfolio backtest.
 *
 * @param {object} context Backtest inputs: symbols, initial_capital,
 *   risk_per_trade, max_positions, min_avg_traded_value, optimization_profile,
 *   hurdle_rate, execution_costs, and an optional `strategies` list.
 * @param {object} [options]
 * @param {string} [options.engineRoot="."] Root that strategy paths resolve against.
 * @param {string} [options.side="long"] Side used to build the default strategy path.
 * @param {string} [options.strategyPath] Strategy path relative to engineRoot.
 * @returns {Promise<object>} Result tagged with `schemaVersion`.
 */
export async function runPortfolioBacktest(context, options = {}) {
  const engineRoot = options.engineRoot ?? ".";
  const side = options.side ?? "long";
  const relativePath = options.strategyPath ?? `local/${side}/strategy.ts`;
  const strategyPath = resolve(engineRoot, relativePath);
  if (!existsSync(strategyPath)) {
    throw new Error(`Strategy not found at ${strategyPath}`);
  }

  const symbols = context.symbols || {};
  const initialCapital = Number(context.initial_capital || 100000.0);
  const maxRiskLimit = Number(context.risk_per_trade || 0.05); // Use configured risk as maximum limit
  const maxHoldDaysOverride = context.max_hold_days == null ? null : Number(context.max_hold_days);
  const maxPositions = Number(context.max_positions || 2);
  const minAvgTradedValue = Number(context.min_avg_traded_value || 0);
  const optimizationProfile = String(context.optimization_profile || "conservative");
  const hurdleRate = Number(context.hurdle_rate || 5.0);
  const executionCosts = context.execution_costs || {};
  const brokeragePerSide = Math.max(0, Number(executionCosts.brokerage_per_side ?? executionCosts.brokeragePerSide ?? 3));
  const slippageBpsPerSide = Math.max(0, Number(executionCosts.slippage_bps_per_side ?? executionCosts.slippageBpsPerSide ?? 5));
  const slippageRate = slippageBpsPerSide / 10000;
  const sizingVersion = "whole-share-risk-cap-v2";

  // Multi-strategy ensemble support: context.strategies is an optional list of
  // relative strategy paths. Falls back to the single argv strategy. The first
  // entry is the "primary" used for open-position re-evaluation.
  const strategyRelPaths = Array.isArray(context.strategies) && context.strategies.length
    ? context.strategies
    : [relativePath];
  const strategyFns = [];
  for (const rel of strategyRelPaths) {
    const abs = resolve(engineRoot, rel);
    if (!existsSync(abs)) continue;
    const mod = await import(pathToFileURL(abs).href);
    if (typeof mod.proposeTrade === "function") {
      strategyFns.push({ path: rel, proposeTrade: mod.proposeTrade });
    }
  }
  if (strategyFns.length === 0) {
    throw new Error("No strategy file exported proposeTrade(history)");
  }
  const proposeTrade = strategyFns[0].proposeTrade;
  // Lets an open position be re-evaluated by the strategy that opened it.
  const strategyByPath = new Map(strategyFns.map((f) => [f.path, f.proposeTrade]));

  // --- Ensemble grading (mirrors the reference ensemble grader) ---
  // This must stay numerically identical to the reference grader: the backtest is only
  // meaningful if candidates are graded the same way the live scanner grades
  // them. The shared contract tests pin the two together.
  const correlationMatrix = context.correlations || {};
  const ENSEMBLE_LAMBDA = 0.5;
  // P(positive net P&L) of a typical setup. Agreement amplifies how far a setup
  // sits from this point, in whichever direction it actually sits.
  const BASE_RATE = 0.45;
  // Confidence is squeezed away from 0/1 because logit diverges at the bounds.
  const LOGIT_EPS = 1e-3;

  function logit(p) {
    const q = Math.min(Math.max(p, LOGIT_EPS), 1 - LOGIT_EPS);
    return Math.log(q / (1 - q));
  }
  function sigmoid(x) {
    // Branch on sign so the exponential never overflows for large |x|.
    if (x >= 0) return 1 / (1 + Math.exp(-x));
    const e = Math.exp(x);
    return e / (1 + e);
  }
  function pairCorrelation(a, b) {
    if (a === b) return 1;
    const r = correlationMatrix[a] && correlationMatrix[a][b];
    if (r !== undefined && r !== null) return Math.max(-1, Math.min(1, r));
    const r2 = correlationMatrix[b] && correlationMatrix[b][a];
    if (r2 !== undefined && r2 !== null) return Math.max(-1, Math.min(1, r2));
    return 0;
  }
  function ensembleWeights(paths) {
    const w = {};
    for (const s of paths) {
      let penalty = 0;
      for (const t of paths) {
        if (t === s) continue;
        penalty += Math.max(pairCorrelation(s, t), 0);
      }
      w[s] = 1 / (1 + penalty);
    }
    return w;
  }
  // null means "this strategy reported no estimate" — which is not the same as
  // estimating 50%, and emphatically not the same as being certain. Silent
  // strategies stay out of the pooled opinion but still count as independent
  // corroboration.
  function normConfidence(conf) {
    if (conf === null || conf === undefined) return null;
    const c = Number(conf);
    if (Number.isNaN(c)) return null;
    return c > 1 ? Math.max(0, Math.min(1, c / 100)) : Math.max(0, Math.min(1, c));
  }
  // Reward:risk of a proposal, 0 when there is no finite target — matching the
  // The representative-proposal tiebreak treats missing reward:risk as zero.
  function proposalRR(proposal) {
    const entry = worstCaseEntry(proposal);
    const risk = entry - proposal.stopLoss;
    if (!(risk > 0)) return 0;
    if (proposal.target === null || proposal.target === undefined) return 0;
    return (proposal.target - entry) / risk;
  }
  function ensembleLongProposal(historySlice, market) {
    const fired = [];
    for (const fn of strategyFns) {
      let proposal;
      try {
        proposal = fn.proposeTrade(historySlice.map((c) => ({ ...c })), market);
      } catch (err) {
        proposal = null;
      }
      if (proposal && proposal.side === "long") {
        fired.push({ path: fn.path, proposal, confidence: normConfidence(proposal.confidence) });
      }
    }
    if (fired.length === 0) return null;
    const paths = fired.map((f) => f.path);
    const weights = ensembleWeights(paths);
    const totalW = Object.values(weights).reduce((a, b) => a + b, 0);
    if (!(totalW > 0)) return null;

    // Pool only the strategies that actually reported a confidence. A silent
    // strategy has no opinion to average in, but it still fired, so it counts
    // toward the independent-agreement multiplier below.
    const reported = fired.filter((f) => f.confidence !== null);
    const reportedW = reported.reduce((acc, f) => acc + weights[f.path], 0);
    const logitAvg = (reported.length > 0 && reportedW > 0)
      ? reported.reduce((acc, f) => acc + weights[f.path] * logit(f.confidence), 0) / reportedW
      : logit(BASE_RATE); // no estimate -> assume a typical setup

    // Effective independent votes: uncorrelated strategies each weigh ~1, so N of
    // them give ~N; correlated ones shrink toward a combined weight near 1.
    const effIndependent = totalW;
    const anchor = logit(BASE_RATE);
    const evidence = anchor + (logitAvg - anchor) * (1 + ENSEMBLE_LAMBDA * (effIndependent - 1));
    const score = Math.max(0, Math.min(1, sigmoid(evidence)));

    // Representative proposal supplies the entry/stop/target. A reported
    // confidence always outranks an unreported one, then higher confidence, then
    // better reward:risk — the independence weight does not decide this.
    const representative = fired.slice().sort((a, b) => {
      const aReported = a.confidence === null ? 0 : 1;
      const bReported = b.confidence === null ? 0 : 1;
      if (aReported !== bReported) return bReported - aReported;
      const ac = a.confidence === null ? 0 : a.confidence;
      const bc = b.confidence === null ? 0 : b.confidence;
      if (ac !== bc) return bc - ac;
      return proposalRR(b.proposal) - proposalRR(a.proposal);
    })[0];

    return {
      score: score,
      // Unbounded pooled log-odds, before the sigmoid. Still separates
      // opportunities whose scores both round to 1.0, so rank on this.
      evidence: evidence,
      effIndependent: effIndependent,
      proposal: representative.proposal,
      strategy: representative.path,
      contributors: fired.map((f) => ({ strategy: f.path, confidence: f.confidence, weight: weights[f.path] })),
    };
  }

  function entryFillPrice(rawPrice) {
    return rawPrice * (1 + slippageRate);
  }

  function worstCaseEntry(proposal) {
    return proposal.side === "long" ? proposal.entry.max : proposal.entry.min;
  }

  function resolveEntryFill(entry, candle) {
    if (candle.high < entry.min || candle.low > entry.max) return null;
    return Math.max(entry.min, Math.min(entry.max, candle.open));
  }

  function closePosition(pos, rawExitPrice) {
    const exitPrice = rawExitPrice * (1 - slippageRate);
    const brokerage = pos.entryBrokerage + brokeragePerSide;
    const slippage = pos.entrySlippage + (rawExitPrice - exitPrice) * pos.qty;
    const pnl = (exitPrice - pos.entry) * pos.qty - brokerage;
    return { exitPrice, pnl, brokerage, slippage };
  }

  const marketIndex = context.market_index;

  // Build per-symbol candle arrays and date index
  const symbolData = {};
  const indexData = {};
  const allDatesSet = new Set();

  for (const [symbol, history] of Object.entries(symbols)) {
    const candles = history.map((candle) => ({
      date: String(candle.date),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0),
    }));
    symbolData[symbol] = candles;
    indexData[symbol] = buildAlignedIndex(candles, marketIndex);
    for (const c of candles) {
      allDatesSet.add(c.date);
    }
  }

  const marketSlice = (symbol, count) => {
    const aligned = indexData[symbol];
    return aligned ? { index: aligned.slice(0, count) } : undefined;
  };

  const allDates = [...allDatesSet].sort();

  // Build per-symbol date -> candle lookup
  const symbolLookup = {};
  for (const [symbol, candles] of Object.entries(symbolData)) {
    const lookup = new Map();
    for (const c of candles) {
      lookup.set(c.date, c);
    }
    symbolLookup[symbol] = lookup;
  }

  function calculateSortinoRatio(capitalSeries, annualHurdleRate = 5.0) {
    if (!capitalSeries || capitalSeries.length < 2) return 0;

    const dailyHurdle = (annualHurdleRate / 100) / 252;
    const dailyReturns = [];

    for (let i = 1; i < capitalSeries.length; i++) {
      const prev = capitalSeries[i - 1].capital;
      if (prev > 0) {
        const ret = (capitalSeries[i].capital - prev) / prev;
        dailyReturns.push(ret);
      }
    }

    if (dailyReturns.length === 0) return 0;

    const meanDailyReturn = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;

    let sumNegativeSquares = 0;

    for (const r of dailyReturns) {
      const diff = r - dailyHurdle;
      if (diff < 0) {
        sumNegativeSquares += diff * diff;
      }
    }

    const downsideDeviation = Math.sqrt(sumNegativeSquares / dailyReturns.length);

    const annualizedExcessReturn = (meanDailyReturn - dailyHurdle) * 252;
    const annualizedDownsideDeviation = downsideDeviation * Math.sqrt(252);

    return annualizedDownsideDeviation > 0 ? (annualizedExcessReturn / annualizedDownsideDeviation) : 0;
  }

  // Helper to run a single simulation pass with a specific risk rate
  function runSimulationPass(riskRate) {
    let capital = initialCapital;
    const activePositions = {};  // symbol -> {entry, stopLoss, target, qty, entryDate, signalDate}
    const plannedEntries = {};   // symbol -> {entryRange, stopLoss, target, signalDate}
    const trades = [];
    const capitalSeries = [];

    for (const date of allDates) {
      // STEP 1: Process planned entries
      const plannedSymbols = Object.keys(plannedEntries);
      const newlyFilled = [];
      const dailyPositionUsage = new Set(Object.keys(activePositions));

      // Calculate available capital at day open
      let committedCapital = 0;
      for (const pos of Object.values(activePositions)) {
        committedCapital += pos.qty * pos.entry + pos.entryBrokerage;
      }
      let availableCapital = Math.max(0, capital - committedCapital);
      let fillSlotsRemaining = Math.max(0, maxPositions - dailyPositionUsage.size);

      for (const symbol of plannedSymbols) {
        const planned = plannedEntries[symbol];
        const candle = symbolLookup[symbol].get(date);

        if (!candle) {
          delete plannedEntries[symbol];
          continue;
        }

        if (candle.open <= planned.stopLoss) {
          delete plannedEntries[symbol];
          continue;
        }

        const rawEntry = resolveEntryFill(planned.entryRange, candle);
        if (rawEntry !== null) {
          if (fillSlotsRemaining <= 0) {
            delete plannedEntries[symbol];
            continue;
          }

          // Trade filled!
          const entry = entryFillPrice(rawEntry);
          const risk = entry - planned.stopLoss;
          let qty = risk > 0 ? (capital * riskRate) / risk : 1;

          const positionCapitalBudget = availableCapital / fillSlotsRemaining;
          const maxQtyByCapital = entry > 0 ? Math.floor(Math.max(0, positionCapitalBudget - brokeragePerSide) / entry) : 0;
          qty = Math.floor(Math.min(qty, maxQtyByCapital));

          if (qty > 0) {
            const position = {
              entry: entry,
              stopLoss: planned.stopLoss,
              target: planned.target,
              signalDate: planned.signalDate,
              entryDate: date,
              qty: qty,
              initialRisk: risk,
              entryBrokerage: brokeragePerSide,
              entrySlippage: (entry - rawEntry) * qty,
              daysOpen: 1,
              maxHoldDays: planned.maxHoldDays,
              setup: planned.setup,
              regime: planned.regime,
              strategyVersion: planned.strategyVersion,
              confidence: planned.confidence ?? null,
              strategy: planned.strategy ?? null,
              ensembleScore: planned.ensembleScore ?? null,
              strategyCount: planned.strategyCount ?? null,
              adjustments: [{ date: planned.signalDate, stopLoss: planned.stopLoss, target: planned.target, label: "entry" }],
            };
            const hitStop = candle.low <= position.stopLoss;
            const hitTarget = position.target !== null && candle.high >= position.target;
            if (hitStop || hitTarget) {
              const rawExitPrice = hitStop ? position.stopLoss : position.target;
              const reason = hitStop ? "stop" : "target";
              const closed = closePosition(position, rawExitPrice);
              capital += closed.pnl;
              trades.push({
                symbol: symbol,
                signalDate: position.signalDate,
                entryDate: position.entryDate,
                exitDate: date,
                entryPrice: position.entry,
                exitPrice: closed.exitPrice,
                stopLoss: position.stopLoss,
                target: position.target,
                qty: position.qty,
                initialRisk: position.initialRisk,
                pnl: closed.pnl,
                brokerage: closed.brokerage,
                slippage: closed.slippage,
                returnPct: position.entry !== 0 ? (closed.pnl / (position.entry * position.qty)) * 100 : 0,
                maxHoldDays: position.maxHoldDays,
                setup: position.setup,
                regime: position.regime,
                strategyVersion: position.strategyVersion,
                confidence: position.confidence ?? null,
                strategy: position.strategy ?? null,
                strategyCount: position.strategyCount ?? null,
                ensembleScore: position.ensembleScore ?? null,
                adjustments: position.adjustments,
                reason: reason,
              });
            } else {
              activePositions[symbol] = position;
              newlyFilled.push(symbol);
            }
            dailyPositionUsage.add(symbol);
            availableCapital -= qty * entry + brokeragePerSide;
            fillSlotsRemaining = Math.max(0, maxPositions - dailyPositionUsage.size);
          }
        }
        delete plannedEntries[symbol];
      }

      // STEP 2: Process exits
      const closingSymbols = [];
      for (const symbol of Object.keys(activePositions)) {
        const pos = activePositions[symbol];
        const candle = symbolLookup[symbol].get(date);

        if (!candle) continue;

        let exitPrice = null;
        let reason = null;

        if (pos.exitNextDayOpen) {
          exitPrice = candle.open;
          reason = "Short Signal";
        } else {
          const hitStop = candle.low <= pos.stopLoss;
          const hitTarget = pos.target !== null && candle.high >= pos.target;

          if (hitStop && hitTarget) {
            exitPrice = pos.stopLoss;
            reason = "stop";
          } else if (hitStop) {
            exitPrice = pos.stopLoss;
            reason = "stop";
          } else if (hitTarget) {
            exitPrice = pos.target;
            reason = "target";
          }
        }

        if (exitPrice !== null) {
          const closed = closePosition(pos, exitPrice);
          const pnl = closed.pnl;
          capital += pnl;
          trades.push({
            symbol: symbol,
            signalDate: pos.signalDate,
            entryDate: pos.entryDate,
            exitDate: date,
            entryPrice: pos.entry,
            exitPrice: closed.exitPrice,
            stopLoss: pos.stopLoss,
            target: pos.target,
            qty: pos.qty,
            initialRisk: pos.initialRisk,
            pnl: pnl,
            brokerage: closed.brokerage,
            slippage: closed.slippage,
            returnPct: pos.entry !== 0 ? (pnl / (pos.entry * pos.qty)) * 100 : 0,
            maxHoldDays: pos.maxHoldDays,
            setup: pos.setup,
            regime: pos.regime,
            strategyVersion: pos.strategyVersion,
            confidence: pos.confidence ?? null,
            strategy: pos.strategy ?? null,
            strategyCount: pos.strategyCount ?? null,
            ensembleScore: pos.ensembleScore ?? null,
            adjustments: pos.adjustments,
            reason: reason,
          });
          closingSymbols.push(symbol);
        }
      }
      for (const symbol of closingSymbols) {
        delete activePositions[symbol];
      }

      // STEP 2.5: Re-evaluate surviving open positions
      const eodCloses = [];
      const newlyFilledSet = new Set(newlyFilled);
      for (const symbol of Object.keys(activePositions)) {
        if (newlyFilledSet.has(symbol)) continue;

        const pos = activePositions[symbol];
        const candles = symbolData[symbol];
        const todayIdx = candles.findIndex((c) => c.date === date);
        if (todayIdx < 0) continue;

        pos.daysOpen = (pos.daysOpen || 0) + 1;

        if (pos.daysOpen >= pos.maxHoldDays) {
          const candle = symbolLookup[symbol].get(date);
          if (candle) {
            const exitPrice = candle.close;
            const closed = closePosition(pos, exitPrice);
            const pnl = closed.pnl;
            capital += pnl;
            trades.push({
              symbol: symbol,
              signalDate: pos.signalDate,
              entryDate: pos.entryDate,
              exitDate: date,
              entryPrice: pos.entry,
              exitPrice: closed.exitPrice,
              stopLoss: pos.stopLoss,
              target: pos.target,
              qty: pos.qty,
              initialRisk: pos.initialRisk,
              pnl: pnl,
              brokerage: closed.brokerage,
              slippage: closed.slippage,
              returnPct: pos.entry !== 0 ? (pnl / (pos.entry * pos.qty)) * 100 : 0,
              maxHoldDays: pos.maxHoldDays,
              setup: pos.setup,
              regime: pos.regime,
              strategyVersion: pos.strategyVersion,
              confidence: pos.confidence ?? null,
              strategy: pos.strategy ?? null,
              strategyCount: pos.strategyCount ?? null,
              ensembleScore: pos.ensembleScore ?? null,
              adjustments: pos.adjustments,
              reason: "time_stop",
            });
            eodCloses.push(symbol);
          }
          continue;
        }

        const historySlice = candles.slice(0, todayIdx + 1);
        if (historySlice.length < 90) continue;

        // Re-evaluate with the strategy that opened this position, not whichever
        // strategy happens to be first in the set. Mirrors the live trail
        // routing in agents/strategy_adapter.originating_strategy().
        const originator = strategyByPath.get(pos.strategy) || proposeTrade;
        const proposal = originator(historySlice.map((c) => ({ ...c })), marketSlice(symbol, todayIdx + 1));
        if (proposal) {
          if (proposal.side === "short") {
            pos.exitNextDayOpen = true;
            const shortEntry = worstCaseEntry(proposal);
            pos.adjustments.push({
              date: date,
              stopLoss: proposal.stopLoss,
              target: proposal.target,
              label: "short_exit_signal (Short Entry: $" + shortEntry.toFixed(2) + ")"
            });
          } else {
            let changed = false;
            if (proposal.stopLoss > pos.stopLoss) {
              pos.stopLoss = proposal.stopLoss;
              changed = true;
            }
            if (proposal.target !== pos.target) {
              pos.target = proposal.target;
              changed = true;
            }
            if (changed) {
              pos.adjustments.push({
                date: date,
                stopLoss: pos.stopLoss,
                target: pos.target,
                label: "re_eval"
              });
            }
          }
        }
      }
      for (const symbol of eodCloses) {
        delete activePositions[symbol];
      }

      // STEP 3: Record capital series
      let unrealized = 0;
      for (const symbol of Object.keys(activePositions)) {
        const pos = activePositions[symbol];
        const candle = symbolLookup[symbol].get(date);
        if (candle) {
          unrealized += (candle.close - pos.entry) * pos.qty;
        }
      }
      const portfolioValue = capital + unrealized;
      capitalSeries.push({ date: date, capital: Math.round(portfolioValue * 100) / 100 });

      // STEP 4: Generate signals for next day
      const committed = Object.keys(activePositions).length;
      const available = maxPositions - committed;
      if (available <= 0) continue;

      const candidates = [];

      for (const symbol of Object.keys(symbolData)) {
        if (symbol in activePositions) continue;

        const candles = symbolData[symbol];
        const candle = symbolLookup[symbol].get(date);
        if (!candle) continue;

        const todayIndex = candles.findIndex((c) => c.date === date);
        if (todayIndex < 0) continue;
        if (todayIndex < 89) continue;

        // 10-day avg traded value
        const atvStart = Math.max(0, todayIndex - 9);
        let atvSum = 0;
        let atvCount = 0;
        for (let i = atvStart; i <= todayIndex; i++) {
          atvSum += candles[i].close * candles[i].volume;
          atvCount++;
        }
        const avgTradedValue = atvCount > 0 ? atvSum / atvCount : 0;

        if (minAvgTradedValue > 0 && avgTradedValue < minAvgTradedValue) continue;

        const historySlice = candles.slice(0, todayIndex + 1);
        const graded = ensembleLongProposal(historySlice, marketSlice(symbol, todayIndex + 1));
        if (graded === null) continue;
        const proposal = graded.proposal;

        const entry = worstCaseEntry(proposal);
        const risk = entry - proposal.stopLoss;
        if (risk <= 0) continue;

        // No profit target means uncapped upside, so there is no finite reward/risk.
        const rr = proposal.target === null ? Infinity : (proposal.target - entry) / risk;

        // Expected value in R-multiples; null when there's no profit target to
        // compute a finite reward/risk from the proposal's expected-risk fields.
        const expectedR = rr === Infinity ? null : graded.score * rr - (1 - graded.score);

        candidates.push({
          symbol: symbol,
          proposal: proposal,
          rr: rr,
          atv: avgTradedValue,
          ensembleScore: graded.score,
          evidence: graded.evidence,
          effIndependent: graded.effIndependent,
          expectedR: expectedR,
          strategy: graded.strategy,
          strategyCount: graded.contributors.length,
          contributors: graded.contributors,
        });
      }

      if (candidates.length === 0) continue;

      // Rank by expectancy in R-multiples so payoff drives selection, not just
      // conviction (mirrors the opportunities scanner). Candidates with no
      // profit target (expectedR === null) sit at the median rather than being
      // penalised to the bottom. Ties break by ensemble score then liquidity.
      const knownExpectedR = candidates
        .map((c) => c.expectedR)
        .filter((v) => v !== null)
        .sort((a, b) => a - b);
      const medianExpectedR = knownExpectedR.length
        ? knownExpectedR[Math.floor(knownExpectedR.length / 2)]
        : 0;
      const rankExpectedR = (c) => (c.expectedR === null ? medianExpectedR : c.expectedR);
      candidates.sort((a, b) => {
        const er = rankExpectedR(b) - rankExpectedR(a);
        if (er !== 0) return er;
        // Rank on the unbounded pooled log-odds, not the squashed score, so
        // candidates whose scores both round to the same value still separate.
        if (b.evidence !== a.evidence) return b.evidence - a.evidence;
        if (b.effIndependent !== a.effIndependent) return b.effIndependent - a.effIndependent;
        return b.atv - a.atv;
      });
      const selected = candidates.slice(0, available);

      for (const s of selected) {
        plannedEntries[s.symbol] = {
          entry: worstCaseEntry(s.proposal),
          entryRange: s.proposal.entry,
          stopLoss: s.proposal.stopLoss,
          target: s.proposal.target,
          maxHoldDays: maxHoldDaysOverride ?? s.proposal.maxHoldDays,
          setup: s.proposal.setup,
          regime: s.proposal.regime,
          strategyVersion: s.proposal.strategyVersion,
          confidence: s.proposal.confidence ?? null,
          strategy: s.strategy,
          ensembleScore: s.ensembleScore,
          strategyCount: s.strategyCount,
          signalDate: date,
        };
      }
    }

    // Close remaining positions at last known price
    for (const symbol of Object.keys(activePositions)) {
      const pos = activePositions[symbol];
      const candles = symbolData[symbol];
      const lastCandle = candles[candles.length - 1];
      const exitPrice = lastCandle.close;
      const closed = closePosition(pos, exitPrice);
      const pnl = closed.pnl;
      capital += pnl;
      trades.push({
        symbol: symbol,
        signalDate: pos.signalDate,
        entryDate: pos.entryDate,
        exitDate: lastCandle.date,
        entryPrice: pos.entry,
        exitPrice: closed.exitPrice,
        stopLoss: pos.stopLoss,
        target: pos.target,
        qty: pos.qty,
        initialRisk: pos.initialRisk,
        pnl: pnl,
        brokerage: closed.brokerage,
        slippage: closed.slippage,
        returnPct: pos.entry !== 0 ? (pnl / (pos.entry * pos.qty)) * 100 : 0,
        maxHoldDays: pos.maxHoldDays,
        setup: pos.setup,
        regime: pos.regime,
        strategyVersion: pos.strategyVersion,
        confidence: pos.confidence ?? null,
        strategy: pos.strategy ?? null,
        strategyCount: pos.strategyCount ?? null,
        ensembleScore: pos.ensembleScore ?? null,
        adjustments: pos.adjustments,
        reason: pos.exitNextDayOpen ? "Short Signal" : "open",
      });
    }

    // Compute drawdown
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    for (const point of capitalSeries) {
      if (point.capital > peak) peak = point.capital;
      const dd = peak - point.capital;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        maxDrawdownPct = peak > 0 ? (dd / peak) * 100 : 0;
      }
    }

    const finalCapital = capitalSeries.length > 0 ? capitalSeries[capitalSeries.length - 1].capital : initialCapital;
    const returnPct = initialCapital > 0 ? ((finalCapital - initialCapital) / initialCapital) * 100 : 0;

    return {
      riskRate,
      finalCapital,
      returnPct,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
      trades,
      capitalSeries
    };
  }

  // STEP 1: Define candidates from 0.5% to the maximum user-defined risk limit
  const candidateRisks = [];
  for (let r = 0.005; r <= maxRiskLimit + 0.0001; r += 0.005) {
    candidateRisks.push(Number(r.toFixed(4)));
  }
  if (candidateRisks.length === 0 || !candidateRisks.includes(Number(maxRiskLimit.toFixed(4)))) {
    candidateRisks.push(Number(maxRiskLimit.toFixed(4)));
  }

  // Sort candidates and filter duplicates
  const finalCandidates = [...new Set(candidateRisks)].sort((a, b) => a - b);

  // Seedable PRNG (mulberry32) — makes Monte Carlo fully deterministic for the same trade data.
  // Seed is derived from each candidate's R-multiples so different strategies get different paths
  // while the same strategy always produces identical ruin/confDD estimates across runs.
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Run a single baseline pass at 1% risk to get the master trade pool of R-multipliers.
  // This ensures that the trade pool is identical across all candidate risk rates, preventing
  // statistical feedback loops and inverting risk metrics due to cash constraints.
  function tradeRMultiple(t) {
    const risk = Number(t.initialRisk) > 0 ? Number(t.initialRisk) : Math.abs(t.entryPrice - t.stopLoss);
    return risk > 0 ? t.pnl / (t.qty * risk) : 0;
  }

  const baselineResult = runSimulationPass(0.01);
  const masterRMultiples = baselineResult.trades.map(tradeRMultiple);

  // STEP 2: Run simulations and gather performance scores + Monte Carlo sequences
  const riskPasses = [];
  for (const r of finalCandidates) {
    const result = runSimulationPass(r);

    // Use the master R-multipliers pool to ensure strictly monotonic risk estimation
    const rMultiples = masterRMultiples.length > 0 ? masterRMultiples : result.trades.map(tradeRMultiple);

    let ruinCount = 0;
    const dds = [];
    const paths = [];
    const numSimulations = 500;
    const ruinThreshold = 0.50; // 50% Drawdown = Ruin

    // Derive a deterministic seed from this candidate's R-multiples.
    // Sum the R-multiples scaled to integers and mix with the risk rate.
    const rawSeed = rMultiples.reduce((acc, v, i) => acc + Math.round(v * 1e6) * (i + 1), 0);
    const seed = (Math.abs(rawSeed) ^ Math.round(r * 1e6)) >>> 0 || 42;
    const rand = mulberry32(seed);
    for (let sim = 0; sim < numSimulations; sim++) {
      let cap = initialCapital;
      const pathCaps = [cap];
      let peak = cap;
      let maxDD = 0;

      for (let step = 0; step < rMultiples.length; step++) {
        // Pick random R-multiple with replacement
        const rMult = rMultiples[Math.floor(rand() * rMultiples.length)] || 0;
        const pnl = cap * r * rMult;
        cap += pnl;
        pathCaps.push(cap);

        if (cap > peak) peak = cap;
        const dd = peak > 0 ? (peak - cap) / peak : 0;
        if (dd > maxDD) maxDD = dd;
      }

      if (maxDD >= ruinThreshold) ruinCount++;
      dds.push(maxDD);
      paths.push({ maxDD, pathCaps });
    }

    const ruinProb = rMultiples.length > 0 ? ruinCount / numSimulations : 0;
    const sortedDDs = [...dds].sort((a, b) => a - b);
    const confDD = rMultiples.length > 0 ? sortedDDs[Math.floor(numSimulations * 0.95)] : 0;

    // Sortino Ratio of the historical EOD capital series
    const sortino = calculateSortinoRatio(result.capitalSeries, hurdleRate);

    // Ruin-Penalty Scoring Model
    let ruinThresholdPercent;
    if (optimizationProfile === "aggressive") {
      ruinThresholdPercent = 0.02; // Under 2.0% Ruin
    } else if (optimizationProfile === "moderate") {
      ruinThresholdPercent = 0.01; // Under 1.0% Ruin
    } else {
      ruinThresholdPercent = 0.004; // Under 0.4% Ruin (effectively zero appetite)
    }

    let score;
    if (optimizationProfile === "aggressive") {
      score = ruinProb <= ruinThresholdPercent ? result.returnPct : -100 - (ruinProb * 100);
    } else {
      score = ruinProb <= ruinThresholdPercent ? sortino : -100 - (ruinProb * 100);
    }

    riskPasses.push({
      risk: r,
      sortino: sortino,
      ruinProb: ruinProb,
      confDD: confDD,
      result: result,
      paths: paths
    });
  }

  // STEP 3: Select optimal risk rate per profile.
  //
  // Design principle — Conservative <= Moderate <= Aggressive in chosen risk rate:
  //
  //   Conservative: LOWEST risk with positive Sortino (safety-first; just needs to beat the hurdle).
  //   Moderate:     PEAK Sortino among valid candidates (risk-adjusted optimum; tiebreak lowest risk).
  //   Aggressive:   HIGHEST return among valid candidates (tiebreak HIGHEST risk — pushes above Moderate
  //                 when returns plateau across a risk band).
  //
  // Profile-specific caps:
  let ruinCeiling = 0.004;
  let confDDCeiling = 0.25;

  if (optimizationProfile === "aggressive") {
    ruinCeiling = 0.02;
    confDDCeiling = 0.45;
  } else if (optimizationProfile === "moderate") {
    ruinCeiling = 0.01;
    confDDCeiling = 0.35; // Distinct gap to make moderate much better off than aggressive
  } else {
    ruinCeiling = 0.004;
    confDDCeiling = 0.25;
  }

  let chosenPass;
  function chooseCapitalPreservationPass(passes) {
    const ranked = [...passes].sort((a, b) =>
      b.result.returnPct - a.result.returnPct ||
      a.result.maxDrawdownPct - b.result.maxDrawdownPct ||
      a.confDD - b.confDD ||
      a.risk - b.risk
    );
    return ranked[0];
  }

  if (optimizationProfile === "aggressive") {
    // Aggressive: highest return, tiebreak HIGHEST risk (most aggressive among equal-return candidates).
    const validPasses = riskPasses.filter(p => p.ruinProb <= ruinCeiling && p.confDD < confDDCeiling);
    if (validPasses.length > 0) {
      validPasses.sort((a, b) => b.result.returnPct - a.result.returnPct || b.risk - a.risk);
      chosenPass = validPasses[0];
    } else {
      // Fallback: relax confDD cap, pick highest-risk ruin-passing candidate.
      const ruinOnly = riskPasses.filter(p => p.ruinProb <= ruinCeiling);
      chosenPass = ruinOnly.length > 0 ? ruinOnly[ruinOnly.length - 1] : riskPasses[riskPasses.length - 1];
    }
  } else if (optimizationProfile === "moderate") {
    // Moderate: Among candidates passing ruin ceiling (≤1.0%) + confDD cap (≤35%), pick best Sortino.
    // Tiebreaker: prefer lowest risk when Sortino scores are within 0.01 of each other.
    const validPasses = riskPasses.filter(p => p.ruinProb <= ruinCeiling && p.confDD < confDDCeiling);
    if (validPasses.length > 0) {
      const bestSortino = Math.max(...validPasses.map(p => p.sortino));
      const topTier = validPasses.filter(p => p.sortino >= bestSortino - 0.01);
      topTier.sort((a, b) => a.risk - b.risk);
      chosenPass = topTier[0];
    } else {
      // Fallback: relax confDD cap, pick best Sortino among ruin-passing candidates.
      const ruinOnly = riskPasses.filter(p => p.ruinProb <= ruinCeiling);
      if (ruinOnly.length > 0) {
        const bestSortino = Math.max(...ruinOnly.map(p => p.sortino));
        const topTier = ruinOnly.filter(p => p.sortino >= bestSortino - 0.01);
        topTier.sort((a, b) => a.risk - b.risk);
        chosenPass = topTier[0];
      } else {
        chosenPass = riskPasses[0];
      }
    }
  } else {
    // Conservative: lowest risk rate with positive Sortino. If no tier beats the
    // hurdle, preserve capital instead of ranking by a negative Sortino ratio.
    const validPasses = riskPasses.filter(p => p.ruinProb <= ruinCeiling && p.confDD < confDDCeiling);
    if (validPasses.length > 0) {
      validPasses.sort((a, b) => a.risk - b.risk);
      chosenPass = validPasses.find(p => p.sortino > 0);
      if (!chosenPass) {
        chosenPass = chooseCapitalPreservationPass(validPasses);
      }
    } else {
      // Fallback: relax confDD cap, same logic.
      const ruinOnly = riskPasses.filter(p => p.ruinProb <= ruinCeiling);
      if (ruinOnly.length > 0) {
        ruinOnly.sort((a, b) => a.risk - b.risk);
        chosenPass = ruinOnly.find(p => p.sortino > 0);
        if (!chosenPass) {
          chosenPass = chooseCapitalPreservationPass(ruinOnly);
        }
      } else {
        chosenPass = riskPasses[0];
      }
    }
  }
  const bestResult = chosenPass.result;

  const wins = bestResult.trades.filter((t) => t.pnl > 0);
  const losses = bestResult.trades.filter((t) => t.pnl <= 0);
  const maxHoldDays = bestResult.trades.reduce((max, trade) => Math.max(max, Number(trade.maxHoldDays || 0)), 0);

  // STEP 4: Extract the representative Monte Carlo Percentile Paths for the UI envelope
  const chosenPaths = chosenPass.paths;
  chosenPaths.sort((a, b) => a.pathCaps[a.pathCaps.length - 1] - b.pathCaps[b.pathCaps.length - 1]);

  const p5Path = chosenPaths[Math.floor(chosenPaths.length * 0.05)].pathCaps;
  const p50Path = chosenPaths[Math.floor(chosenPaths.length * 0.50)].pathCaps;
  const p95Path = chosenPaths[Math.floor(chosenPaths.length * 0.95)].pathCaps;

  const mcDates = [bestResult.capitalSeries[0].date, ...bestResult.trades.map(t => t.exitDate)];
  const p5Series = p5Path.map((cap, i) => ({ date: mcDates[i] || mcDates[mcDates.length - 1], capital: Math.round(cap * 100) / 100 }));
  const p50Series = p50Path.map((cap, i) => ({ date: mcDates[i] || mcDates[mcDates.length - 1], capital: Math.round(cap * 100) / 100 }));
  const p95Series = p95Path.map((cap, i) => ({ date: mcDates[i] || mcDates[mcDates.length - 1], capital: Math.round(cap * 100) / 100 }));

  // Prepare sensitivity matrix for the UI using profile-specific ceilings
  const sensitivityMatrix = riskPasses.map(p => ({
    riskPct: Number((p.risk * 100).toFixed(2)),
    returnPct: Number(p.result.returnPct.toFixed(2)),
    maxDrawdownPct: Number(p.result.maxDrawdownPct.toFixed(2)),
    ruinProbPct: Number((p.ruinProb * 100).toFixed(2)),
    confDDPct: Number((p.confDD * 100).toFixed(2)),
    sortino: Number(p.sortino.toFixed(2)),
    isRecommended: p.risk === chosenPass.risk,
    ruinDisqualified: p.ruinProb > ruinCeiling,
    confDDDisqualified: p.ruinProb <= ruinCeiling && p.confDD >= confDDCeiling,
  }));

  // Per-strategy attribution over the chosen risk pass (representative strategy per trade).
  const perStrategyContribution = {};
  for (const t of bestResult.trades) {
    const key = t.strategy || relativePath;
    const bucket = perStrategyContribution[key] || (perStrategyContribution[key] = { trades: 0, pnl: 0, wins: 0 });
    bucket.trades += 1;
    bucket.pnl += t.pnl;
    if (t.pnl > 0) bucket.wins += 1;
  }


  return {
    schemaVersion: SCHEMA_VERSION,
    initialCapital: initialCapital,
    finalCapital: bestResult.finalCapital,
    strategies: strategyRelPaths,
    perStrategyContribution,
    totalPnL: bestResult.finalCapital - initialCapital,
    returnPct: bestResult.returnPct,
    totalTrades: bestResult.trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: bestResult.trades.length > 0 ? wins.length / bestResult.trades.length : 0,
    maxDrawdown: bestResult.maxDrawdown,
    maxDrawdownPct: bestResult.maxDrawdownPct,
    maxPositions: maxPositions,
    maxHoldDays: maxHoldDays || null,
    riskPerTrade: chosenPass.risk, 
    originalRiskPerTrade: maxRiskLimit, 
    sizingVersion,
    brokeragePerSide,
    slippageBpsPerSide,
    trades: bestResult.trades,
    capitalSeries: bestResult.capitalSeries,
    riskSensitivity: sensitivityMatrix,
    ruinProbability: chosenPass.ruinProb, // Pass optimal ruin probability
    confidenceDrawdown: chosenPass.confDD, // Pass 95% worst-case drawdown
    sortino: chosenPass.sortino, // Pass optimal sortino ratio
    mcP5: p5Series,
    mcP50: p50Series,
    mcP95: p95Series
  };
}
