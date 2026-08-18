# Security Policy

This project runs coding agents with file-system access and executes generated
strategy code locally. Treat it as you would any tool that runs untrusted code
on your machine: prefer a sandbox or a dedicated user account.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository, rather than opening a public issue.

## Scope notes

- Agent API keys are read from the environment and are never committed.
  `.env` files, `*.pem`, and `*.key` are ignored by `.gitignore`.
- No market data or credentials are distributed with this repository.
- Generated strategy code is evaluated by executing it. Do not run this harness
  against strategy files from sources you do not trust.
