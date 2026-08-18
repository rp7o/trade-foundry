// Public entry point for the vendored trading strategy engine.

export { runPortfolioBacktest, SCHEMA_VERSION } from "./portfolio-backtest.mjs";
export { runPortfolioBacktestInWorker } from "./worker-pool.mjs";
