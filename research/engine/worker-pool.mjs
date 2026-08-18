// Off-thread wrapper around runPortfolioBacktest.
//
// Callers limit how many of these run at once; one worker per backtest keeps
// each run's module graph and strategy import isolated, exactly as the previous
// process-per-backtest design did, without paying to start a new runtime.

import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./backtest-worker.mjs", import.meta.url);

export function runPortfolioBacktestInWorker(context, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { context, options } });
    let settled = false;

    worker.once("message", (result) => {
      settled = true;
      resolve(result);
      void worker.terminate();
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`backtest worker exited with code ${code}`));
    });
  });
}
