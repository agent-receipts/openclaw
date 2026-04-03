# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Instead, please use GitHub's **Report a vulnerability** feature on this repository.

Include as much detail as possible: description, steps to reproduce, impact assessment, and any suggested fix.

## Scope

Security reports for this plugin cover:

- Receipt signature forgery or bypass
- Hash chain integrity violations
- Key material leakage (private keys exposed via logs, tools, or store)
- Injection attacks through tool parameters or taxonomy config
- Privilege escalation through the plugin's OpenClaw hooks

Issues in the underlying `@agent-receipts/sdk-ts` SDK should be reported to the [sdk-ts repository](https://github.com/agent-receipts/sdk-ts/security).

## Disclosure Policy

- Reports are triaged within 48 hours
- Fixes are coordinated with the reporter before public disclosure
- Reporters are credited in release notes unless they prefer anonymity
