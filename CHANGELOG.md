# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Classify `sessions_spawn` and `subagents` as `system.command.execute` (high risk)
  instead of `system.application.launch` (low risk). Spawning a new agent session is
  a high-privilege operation; receipts now reflect that in audit trails (#106).

## [0.4.1] - 2026-04-27

### Fixed
- Recover chain state from the store after a plugin restart. When the process restarts
  mid-session, the in-memory sequence counter was re-initialised to 0 while the database
  still held prior receipts, causing every subsequent `store.insert` to fail with
  `UNIQUE constraint failed: receipts.chain_id, receipts.sequence` and leaving the chain
  permanently stuck for that session (#103).

## [0.4.0] - 2026-04-27

### Added
- **Parameter preview** — opt-in selective disclosure of action parameters in receipts.
  Configure via `parameterPreview: true | "high" | string[] | false` (default `false`).
  When enabled, specific named fields (e.g. `command`, `path`, `url`) are stored verbatim
  in `parameters_preview` alongside the existing SHA-256 parameters hash.

### Changed
- Bump `@agnt-rcpt/sdk-ts` to `^0.5.0`, which adds `parameters_preview` natively to the
  `Action` type. The local `ActionWithPreview` bridge type has been removed.

## [0.3.3] - 2026-04-27

### Fixed
- CLI entrypoint is now always invoked via the `openclaw-agent-receipts` bin regardless of
  invocation path (#97).

## [0.3.2] - 2026-04-27

### Changed
- Bump `@agnt-rcpt/sdk-ts` to `0.4.1`.
- Add `CLAUDE.md` (imports `AGENTS.md`) for Claude Code IDE integration (#88).

### Fixed
- Assert `error` key absent on success path in receipt outcome tests (#94).

## [0.3.1] - 2026-04-27

### Changed
- Bump `@agnt-rcpt/sdk-ts` to `^0.4.0` (#82).
- Require Node.js `>=22.11.0` to match SDK peer requirement.
- SHA-pin all GitHub Actions for supply chain security (#76).
- Add Dependabot config for automated dependency and Actions updates (#77).
- Add Conventional Commits enforcement via Lefthook and convco (#75).

### Fixed
- `openclaw.extensions` entry now points at the compiled `dist/` entry, not source (#85).

## [0.3.0] - 2026-04-03

### Changed
- Renamed package scope and all identifiers from `attest-protocol` to `agent-receipts` /
  `@agnt-rcpt`. Package is now `@agnt-rcpt/openclaw` (#43–#48).
- Upgrade Node.js runtime from 22 to 24 in CI (#52).
- Workflow dispatch no longer requires a version tag (#51).

### Added
- Security guidelines, agent safety rules, and GitHub issue/PR templates (#54).
- Comprehensive `AGENTS.md` with contribution guidelines, mindset rules, and agent
  safety constraints (#61–#71).

## [0.2.0] - 2026-04-01

### Added
- Pattern-based auto-classification: tool names not in the exact-match taxonomy fall
  back to regex patterns (#34).
- JSON-LD receipt export (#33).
- `openclaw-agent-receipts` CLI for receipt exploration (#32).
- `AGENTS.md` for multi-agent IDE support (#31).
- Factory pattern for agent tools; deterministic service lifecycle (#28).
- Full taxonomy of OpenClaw built-in tools.
- Integration smoke test covering the complete plugin lifecycle (#25).

### Changed
- All mutable state now flows through `HookDeps` — no module-level singletons,
  making multiple plugin instances safe (#23).

### Fixed
- Security hardening: key file permissions, input validation, pending-map memory
  leak prevention (#22).

[Unreleased]: https://github.com/agent-receipts/openclaw/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/agent-receipts/openclaw/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/agent-receipts/openclaw/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/agent-receipts/openclaw/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/agent-receipts/openclaw/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/agent-receipts/openclaw/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/agent-receipts/openclaw/releases/tag/v0.2.0
