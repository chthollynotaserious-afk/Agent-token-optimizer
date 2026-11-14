[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

# Security Policy

## Supported Versions

| Version | Supported | Notes |
| --- | --- | --- |
| `2.0.0-alpha.x` (Universal Agent Optimizer) | :white_check_mark: | Active development branch (`main`) |
| `1.x` (Legacy `Opt-1 ~ Opt-5` modules) | :white_check_mark: | Compatibility shims & regression fixes |
| `< 1.0` | :x: | Unsupported pre-release snapshots |

## Security Boundaries & Design Guarantees

- **Zero Credential Persistence:** This library never reads, stores, or transmits provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.). In Proxy mode (`createProxyServer`), authorization headers are only forwarded upstream in memory for the active request.
- **Fail-Closed Scope ACL:** Multi-tenant context selection (`selectUniversalContext` / `canAccessScope`) fails closed when tenant/scope metadata is missing or mismatched, and honors redaction callbacks without falling back to raw text.
- **External Optimizer Isolation:** Optional third-party plugins (`HeadroomPlugin`, `ContextCompressPlugin`, `RTKPlugin`) execute through circuit breakers and fall back safely to original content on timeouts or errors.

## Reporting a Vulnerability

If you discover a security vulnerability (such as a Scope ACL bypass, secret leakage into ledger/audit logs, or proxy header/request smuggling issue):

1. **Do not open a public GitHub issue** with exploit payloads, live API keys, or private conversation logs.
2. Report privately via **GitHub Security Advisories** (`Security` -> `Advisories` -> `Report a vulnerability` on this repository).
3. Include affected module/file paths, reproduction steps (using synthetic inputs), and potential impact.

We aim to acknowledge reports within **72 hours** and coordinate remediation before public disclosure.
