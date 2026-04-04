---
applyTo: "**"
---

# Review guidelines

This is an OpenClaw plugin that generates cryptographically signed, hash-linked audit trails for agent tool calls using Agent Receipts.

## Security

- Flag any real private keys, secrets, or credentials in the diff.
- Ed25519 is the only supported signing algorithm. Flag any introduction of alternative or weaker schemes.
- Parameters must only appear as SHA-256 hashes in receipts, never in plaintext. Flag any plaintext parameter storage.
- Flag any changes to `.github/workflows/` — these require explicit maintainer review.
- Flag any changes to `openclaw.plugin.json` — it defines the plugin's public contract and requires maintainer approval.

## Code quality

- ESM-only: relative imports must use `.js` extensions. Flag relative imports missing the `.js` extension (package imports and `node:` built-ins are fine).
- Strict TypeScript: no `any`, no type assertions unless unavoidable. Flag `as` casts and `any` types.
- No module-level mutable state — all mutable state must flow through `HookDeps`. Flag module-scoped `let` or mutable singletons.
- Colocated tests: `foo.ts` → `foo.test.ts` in the same directory.
- `taxonomy.json` is canonical for tool classification. Taxonomy changes must include corresponding test updates in `src/classify.test.ts`.
- Flag unused code, dead imports, and breadcrumb comments ("moved to X", "removed").
- Flag any `TODO` or `FIXME` comments that don't reference an issue number.
