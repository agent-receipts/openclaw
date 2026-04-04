# AGENTS.md

OpenClaw plugin that generates cryptographically signed, hash-linked audit trails
for every tool call an agent makes, using Agent Receipts. Receipts are W3C
Verifiable Credentials stored in a local SQLite database.

## Commands

```bash
pnpm install        # install deps
pnpm build          # compile (tsc → dist/)
pnpm test           # vitest
pnpm test:coverage  # vitest + V8 coverage
pnpm typecheck      # tsc --noEmit
```

CI runs typecheck + vitest + V8 coverage via GitHub Actions.

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Plugin entry — wires hooks, tools, and service lifecycle |
| `src/hooks.ts` | `before_tool_call` / `after_tool_call` handlers, receipt creation |
| `src/chain.ts` | Per-session hash-linked chain state |
| `src/classify.ts` | Tool name → action type + risk level via taxonomy |
| `src/tools.ts` | Agent-facing tools: `ar_query_receipts`, `ar_verify_chain` |
| `src/config.ts` | Config resolution, Ed25519 key management |
| `taxonomy.json` | Source of truth for tool → action type mappings |
| `openclaw.plugin.json` | Plugin manifest (config schema, tool contracts) |

## Code conventions

- **ESM-only** (`"type": "module"`, imports use `.js` extensions)
- **Strict TypeScript** — no `any`, no type assertions unless unavoidable
- **Colocated tests** — `foo.ts` → `foo.test.ts` in the same directory
- **Factory pattern for tools** — tool factories receive deps at registration time
- **No module-level mutable state** — all mutable state flows through `HookDeps` (multi-instance safe)
- **`taxonomy.json` is canonical** — tool classification comes from this file; custom taxonomies can override via config
- **Parameters are never stored plaintext** — only SHA-256 hashes in receipts

## Testing

- All new code needs tests — add a colocated `.test.ts` file
- `src/integration.test.ts` covers the full plugin lifecycle against a mock OpenClaw API
- Shared helpers in `src/test-helpers.ts`
- Tests must pass before merging: `pnpm test && pnpm typecheck`

## Reference files

- `src/hooks.ts` — lifecycle hook pattern: dependency injection via `HookDeps`, no module-level state, memory leak prevention
- `src/classify.test.ts` — taxonomy test structure: exact mappings, custom overrides, pattern precedence, edge cases with temp directory isolation
- `src/integration.test.ts` — full plugin lifecycle test: mock API setup, multi-step tool call flow, receipt and chain verification
- `src/test-helpers.ts` — test fixture factories: `makeHookDeps()` for isolated state, `simulateToolCall()` for multi-step helpers

## Dependencies

- `@agnt-rcpt/sdk-ts` — Agent Receipts SDK (receipts, store, signing)
- `@sinclair/typebox` — JSON schema for tool parameter validation
- `openclaw` — peer dependency (`>=2025.0.0`)

## Security

- Never commit real private keys. Test fixtures use well-known test keys only (see `src/test-helpers.ts`).
- Parameters are never stored in plaintext — only SHA-256 hashes appear in receipts. Do not weaken this.
- Ed25519 is the only supported signing algorithm. Do not introduce alternative or weaker schemes.
- Report vulnerabilities via [GitHub Security Advisories](https://github.com/agent-receipts/openclaw/security/advisories/new), not public issues. See [SECURITY.md](SECURITY.md).

## Mindset

- Think before acting. Understand the problem before writing code.
- Work like a craftsman — do the better fix, not the quickest fix.
- Fix from first principles, not bandaids.
- Write idiomatic, simple, maintainable code.
- Delete unused code ruthlessly. No breadcrumb comments ("moved to X", "removed").
- Leave the repo better than you found it.

## Papercut rule

- Fix small issues you notice while working (typos, dead imports, minor inconsistencies).
- Raise larger cleanups with the user before expanding scope.

## Timeout handling

- If a command runs longer than 35 minutes, stop it, capture logs/context, and check with the user.
- Do not wait indefinitely for hung processes.

## Adding dependencies

- Research before adding — prefer well-maintained, widely-used packages with good APIs.
- Avoid unmaintained dependencies (check last commit date, open issues, bus factor).
- Prefer the standard library when it covers the use case adequately.
- New dependencies require justification in the PR description.
- For TypeScript: check npm weekly downloads and maintenance status.
- Supply chain security matters for a plugin in the crypto/audit space — evaluate carefully.

## Completing work

Before marking work as complete:

1. Confirm all touched tests and linters pass.
2. Re-read your full diff — check for mistakes, consistency, and completeness.
3. Summarise changes with file and line references.
4. Mention any opportunistic papercut fixes made along the way.
5. Call out TODOs, follow-up work, or uncertainties.
6. If opening a PR, verify the description accurately reflects the changes.

## Agent safety rules

When working in this repo as an AI coding agent, these rules apply in addition to the conventions above:

- **Never modify CI/CD workflows** (`.github/workflows/`) without explicit human review
- **Never weaken cryptographic parameters** — do not change key sizes, hash algorithms, or signature schemes
- **Never skip or delete existing tests** — add tests, don't remove them
- **Never generate real cryptographic keys** — always use fixtures from `src/test-helpers.ts`
- **Never modify `openclaw.plugin.json`** without explicit human approval — it defines the plugin's public contract
- **Always run `pnpm test && pnpm run typecheck`** before proposing changes
- **Taxonomy changes** (`taxonomy.json`) must include corresponding test updates in `src/classify.test.ts`
- **Use git worktrees** for new work — do not edit directly on main or shared branches, to avoid conflicts with other agents or in-progress work
- **Self-review before committing** — follow the Completing work checklist above
