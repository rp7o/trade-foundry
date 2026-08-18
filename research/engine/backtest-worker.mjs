// Worker entry point for runPortfolioBacktestInWorker.
//
// A backtest is CPU-bound and fully synchronous once it starts, so running one
// per worker thread is what keeps fold sweeps parallel across cores.

import { parentPort, workerData } from "node:worker_threads";
import { runPortfolioBacktest } from "./portfolio-backtest.mjs";

const { context, options } = workerData;
parentPort.postMessage(await runPortfolioBacktest(context, options));
