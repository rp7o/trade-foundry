# Generic Harness

This directory contains reusable AutoResearch infrastructure. It must remain independent of any research domain.

## Do

- Use domain-neutral concepts and terminology.
- Implement deterministic execution, evaluation, persistence, safety, and lifecycle primitives.
- Expose configuration and hooks for domain-specific behavior.
- Keep interfaces usable by unrelated research domains.

## Do Not

- Reference trading, strategies, hypotheses, market data, or domain artifact paths.
- Encode domain policies, prompts, candidate structures, or naming.
- Import from a directory under `research/`.
- Add a special case for the current research domain.

If a change needs domain knowledge, it belongs under the relevant `research/` directory or behind a generic hook.
