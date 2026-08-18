# Research Domains

This directory owns all domain-specific research behavior and knowledge.

Each domain is responsible for its evaluator, artifacts, policies, prompts, hooks, and domain terminology. Domains may use generic infrastructure from `src/`; generic infrastructure must not depend on a domain.

Keep domain-specific orchestration close to its domain. Share behavior through explicit generic interfaces only when it is genuinely reusable across unrelated domains.

`engine/` is the exception to per-domain ownership: it is the vendored backtest engine, shared by any trading domain and imported as a library. It lives here rather than in `src/` because it carries trading knowledge. Treat it as a frozen execution boundary; see `engine/README.md`.
