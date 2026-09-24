// Worker entry point for runPortfolioBacktestInWorker.
//
// A backtest is CPU-bound and fully synchronous once it starts. One worker per
// window keeps folds parallel; grouped profiles share one risk sweep.

import { parentPort, workerData } from "node:worker_threads";
import { runPortfolioBacktest } from "./portfolio-backtest.mjs";

const { context, options } = workerData;
if (options.profiles) {
  const sharedRiskPasses = {};
  const results = [];
  for (const profile of options.profiles) {
    results.push(await runPortfolioBacktest(
      { ...context, optimization_profile: profile },
      { ...options, sharedRiskPasses, profiles: undefined },
    ));
  }
  parentPort.postMessage(results);
} else {
  parentPort.postMessage(await runPortfolioBacktest(context, options));
}
