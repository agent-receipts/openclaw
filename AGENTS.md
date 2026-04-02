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
| `src/tools.ts` | Agent-facing tools: `attest_query_receipts`, `attest_verify_chain` |
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

## Dependencies

- `@agnt-rcpt/sdk-ts` — Agent Receipts SDK (receipts, store, signing)
- `@sinclair/typebox` — JSON schema for tool parameter validation
- `openclaw` — peer dependency (`>=2025.0.0`)
