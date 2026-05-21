# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (breaking)

- **Daemon is now required (ADR-0010 Flavor B).** The plugin no longer holds keys, chain state, or a local SQLite store. Every tool call is forwarded to the local agent-receipts daemon over AF_UNIX; the daemon signs, hash-links, and stores receipts. If the socket is unreachable at startup, a warning is logged. Per-frame delivery is fire-and-forget — no receipts are recorded while the daemon is absent.
- **Config surface changed.** `dbPath`, `keyPath`, and `daemonForwarding` are deprecated and ignored. New optional fields: `daemonDbPath` and `daemonPublicKeyPath` override the daemon's default SQLite and public-key paths.
- **`ar_query_receipts` queries the daemon DB** (all sessions, no chain-scope filter). The `chain_id` and `all_chains` parameters have been removed. Results include receipts across all sessions.
- **`ar_verify_chain` reads the daemon DB and public key from disk.** Chain auto-discovery picks the first chain found; pass `chain_id` explicitly in multi-chain stores.
- **Issuer DID.** Historical Flavor A chains were signed by the plugin under `did:openclaw:<agentId>`. New chains are signed by the daemon using its own identity. The discontinuity is expected; see the upgrade guide in the README.
- **`parameterDisclosure` plugin config is now a no-op** and emits a startup warning. Use the daemon's `--parameter-disclosure` flag instead.

### Removed

- `src/chain.ts` — chain state (sequence, previous hash, chain ID) is now managed by the daemon.
- `loadOrCreateKeys` — the plugin no longer generates or holds Ed25519 keys.
- Local `store.insert` path — receipts are never written by the plugin process.

### Added

- `src/daemon-store.ts` — opens the daemon's SQLite receipt database read-only via `DatabaseSync` URI mode.
- `DaemonStoreReader` type — narrow interface (`query`, `stats`, `close`, `getChain`) limits callers to read-only operations.
- `verifyDaemonChain` helper — centralises the one unsafe cast needed to bridge `DaemonStoreReader` with `verifyStoredChain`.
- Startup warning when the daemon socket is unreachable, with install instructions.
- Caller-bug errors returned by `emitter.emit()` (e.g. invalid event fields, closed emitter) are now logged at warn level via the plugin logger. Transport-level drops (daemon unreachable mid-session) remain fire-and-forget and are not individually logged.

## [0.8.0] - 2026-05-15

### Fixed

- **Socket path fallback on Linux** ([#133](https://github.com/agent-receipts/openclaw/issues/133)):
  When `XDG_RUNTIME_DIR` is unset (common when the gateway runs as a system
  service with `User=`), the daemon emitter now resolves the socket path from
  `process.getuid()` (`/run/user/<uid>/agentreceipts/events.sock`) before
  falling back to the system-wide path. Previously it fell back directly to
  `/run/agentreceipts/events.sock`, silently misdirecting frames.

### Added

- **Startup warning when daemon socket unreachable** ([#133](https://github.com/agent-receipts/openclaw/issues/133)):
  If `daemonForwarding` is enabled but the resolved socket path is unreachable
  at startup, the plugin now logs a clear two-line warning with the socket path
  and a link to the daemon setup guide. Previously the mismatch was silent.
- **Daemon setup documentation** ([#132](https://github.com/agent-receipts/openclaw/issues/132)):
  README now includes a "Setting up the daemon" subsection under
  `daemonForwarding` covering macOS (Homebrew), Linux (install script), and the
  `XDG_RUNTIME_DIR` system-service gotcha.

### Changed

- Version bump to `0.8.0` to maintain lockstep with the coordinated
  agent-receipts v0.8.0 release.

## [0.6.0] - 2026-05-02

### Changed (breaking)
- **`ar_query_receipts` now defaults to the current session's chain** instead
  of querying every chain in the store. Pass `all_chains: true` to restore the
  prior global-query behavior. Cross-session audit callers should opt in
  explicitly (#118, #119).

### Fixed
- `ar_query_receipts` respects `timestamp_after` — previously the parameter
  was missing from the tool schema, so it was silently dropped before reaching
  the SDK and stale receipts were returned (#118).
- `ar_query_receipts` returns the *newest* receipts by default. The SDK's
  underlying query orders ASC, so the prior `limit: 20` returned the 20
  oldest receipts in larger sessions, making real-time auditing impossible
  (#118).
- `limit` parameter is clamped — negative or fractional values fall back to
  the default 20 instead of producing surprising slices like "all-but-last".

### Added
- New `ar_query_receipts` filters: `chain_id`, `timestamp_after` (exclusive),
  `timestamp_before` (inclusive), `all_chains`.
- Result objects now include `chain_id` so callers can identify the source
  chain and reuse it in follow-up queries.
- Polling guidance in the tool description: pass `timestamp_after` set to the
  timestamp of the last receipt you've seen.

### Known limitations
- Stores with >10,000 matching receipts may miss the newest results
  (SDK-level default cap). Tracked in
  [agent-receipts/ar#300](https://github.com/agent-receipts/ar/issues/300).
- Same-millisecond bursts beyond `limit` can drop unread receipts during
  polling. Tracked in [#121](https://github.com/agent-receipts/openclaw/issues/121).
- Exclusive `timestamp_after` filter compares ISO 8601 strings byte-wise, not
  instant-wise. Tracked in [#122](https://github.com/agent-receipts/openclaw/issues/122).

## [0.5.0] - 2026-05-01

### Changed (breaking)
- **Renamed `parameterPreview` → `parameterDisclosure`** (config option),
  `preview_fields` → `disclosure_fields` (taxonomy entries), and the receipt
  field `parameters_preview` → `parameters_disclosure`. Mirrors the SDK rename
  in [`@agnt-rcpt/sdk-ts` 0.6.0](https://github.com/agent-receipts/ar/releases/tag/sdk-ts-v0.6.0)
  per [ADR-0012](https://github.com/agent-receipts/ar/blob/main/docs/adr/0012-payload-disclosure-policy.md):
  "preview" misdescribed a permanent, signed field. No deprecation alias is
  provided — update plugin config and any custom taxonomy files before
  upgrading.

### Changed
- Bump `@agnt-rcpt/sdk-ts` to `^0.6.0`. The SDK now also surfaces
  `hashReceipt` and `verifyReceipt` errors in `ChainVerification.error`
  (previously swallowed), improving diagnostics from `ar_verify_chain`.

## [0.4.2] - 2026-04-27

### Fixed
- Classify `sessions_spawn` and `subagents` as `system.command.execute` (high risk)
  instead of `system.application.launch` (low risk). Spawning a new agent session is
  a high-privilege operation; receipts now reflect that in audit trails (#106).
- Scope `session_start` pending-stash eviction to the current session only. Previously
  `pending.clear()` wiped stashed call data for every in-flight tool call across all
  sessions, causing concurrent sessions to lose their `startedAt` timestamp and fall
  back to recomputing `paramsHash` from the event params instead of the original stash
  (#107).
- Scope pending eviction by `(sessionKey, sessionId)` pair, not `sessionKey` alone.
  Two sessions sharing a `sessionKey` but with different `sessionIds` are distinct;
  evicting by `sessionKey` alone still allowed one session's `session_start` to clear
  another's pending stash (#107).

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

[Unreleased]: https://github.com/agent-receipts/openclaw/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/agent-receipts/openclaw/compare/v0.6.0...v0.8.0
[0.6.0]: https://github.com/agent-receipts/openclaw/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/agent-receipts/openclaw/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/agent-receipts/openclaw/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/agent-receipts/openclaw/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/agent-receipts/openclaw/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/agent-receipts/openclaw/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/agent-receipts/openclaw/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/agent-receipts/openclaw/releases/tag/v0.2.0
