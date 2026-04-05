# Contributing

Contributions are welcome! This plugin is part of the [Agent Receipts](https://github.com/agent-receipts) ecosystem.

## Reporting Issues

Open a GitHub issue for:

- Bugs in receipt generation or chain integrity
- Incorrect taxonomy mappings
- Missing OpenClaw tool classifications
- Documentation gaps

## Development Setup

```bash
git clone https://github.com/agent-receipts/openclaw.git
cd openclaw
pnpm install
```

### Commands

| Command | Description |
|---------|-------------|
| `pnpm run build` | Compile TypeScript to dist/ |
| `pnpm test` | Run test suite |
| `pnpm test:coverage` | Run tests with coverage |
| `pnpm run typecheck` | TypeScript type checking |

## Development Process

1. Fork the repo and create a branch from `main`
2. Follow the existing code conventions
3. Run `pnpm run typecheck` and `pnpm test`
4. Open a pull request

## Code Conventions

- TypeScript ESM with strict mode
- Use `import type` for type-only imports
- Test files as colocated `*.test.ts` in `src/`
- Vitest for all tests; cover edge cases
- Never push directly to `main`

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must start with a type:

```
feat: add new feature
fix: correct a bug
docs: update documentation
chore: maintenance task
refactor: restructure without behavior change
test: add or update tests
ci: change CI/CD configuration
```

The `commit-msg` hook enforces this via [convco](https://convco.github.io/check/). Install hooks with:

```bash
brew install lefthook convco          # macOS
cargo install convco                  # Linux / Windows / any platform with Rust
lefthook install
```

See the [convco installation docs](https://convco.github.io/check/installation/) for all options.

## Taxonomy Contributions

Adding mappings for new OpenClaw tools is a great way to contribute. Edit `taxonomy.json` and add corresponding tests in `src/classify.test.ts`.

## Spec Alignment

This plugin implements the [Action Receipt Protocol](https://github.com/agent-receipts/spec) via the `@agnt-rcpt/sdk-ts` SDK. Changes must remain compatible with the protocol specification.

## Working with AI agents

AI agents (Claude Code, GitHub Copilot, etc.) are first-class contributors to this project. See [AGENTS.md](AGENTS.md) for the full agent safety rules and conventions.

**Test-driven workflow** — the highest-leverage pattern for agent-assisted development:

1. Write a failing test that describes the expected behavior.
2. Let the agent implement the fix or feature to make the test pass.
3. The test output gives the agent a tight feedback loop — it can iterate without guessing.

**Agent boundaries** — agents must follow the [Agent safety rules](AGENTS.md#agent-safety-rules). Key constraints: no `openclaw.plugin.json` changes without human approval, no CI/CD workflow changes without explicit human review, no real cryptographic keys.

## Pre-submit checklist

Before opening a PR, verify:

- [ ] `pnpm test` passes
- [ ] `pnpm run typecheck` passes
- [ ] No real keys or secrets in the diff — use test fixtures only
- [ ] Taxonomy changes include corresponding tests in `src/classify.test.ts`
- [ ] AGENTS.md updated if you changed project structure
- [ ] Commit message follows [Conventional Commits](https://www.conventionalcommits.org/) format

## License

MIT
