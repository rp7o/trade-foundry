# Trade Long Domain

This directory is the ownership boundary for the trade-long research domain.

It owns trading concepts, strategy artifacts, evaluation rules, hypothesis policy, prompts, and lifecycle hooks. The configured workflow hook owns domain orchestration. Domain behavior should remain here rather than leaking into `src/`.

Prefer configuring or extending generic harness hooks. Do not duplicate generic execution, persistence, safety, or process-management infrastructure inside this domain.
