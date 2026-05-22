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

## Changelog

User-visible changes (features, fixes, breaking changes, deprecations) belong in [`CHANGELOG.md`](CHANGELOG.md). Add an entry under the `## [Unreleased]` heading as part of your PR. This repo extends [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with a custom `Changed (breaking)` section to separate breaking changes from regular improvements; use standard Keep a Changelog sections (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) plus `Changed (breaking)`. Link the issue or PR number when there is one.

Internal-only changes (refactors with no observable behavior change, CI tweaks, test-only edits) do not need a changelog entry.

The release script promotes `## [Unreleased]` to a versioned heading and rewrites the reference links at the bottom of the file, so contributors only need to add the entry — versioning is automatic.

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

## Release Process

Releases are cut by maintainers using `scripts/release.sh`. The script handles the full flow end-to-end.

```bash
# Preview all steps without making any changes
bash scripts/release.sh --dry-run patch

# Cut a patch / minor / major release
bash scripts/release.sh patch   # e.g. 0.4.2 → 0.4.3
bash scripts/release.sh minor   # e.g. 0.4.2 → 0.5.0
bash scripts/release.sh major   # e.g. 0.4.2 → 1.0.0

# Pin to an exact version
bash scripts/release.sh 1.0.0
```

**Prerequisites:** `gh` (GitHub CLI, authenticated), `git`, `node`, `npm`.

What the script does:

1. Validates preconditions — clean working tree, on `main`, required tools available
2. Computes the new version
3. Promotes `## [Unreleased]` in `CHANGELOG.md` to the new versioned entry
4. Bumps `package.json`
5. Commits (`chore(release): vX.Y.Z`), tags, and pushes
6. Creates the GitHub Release — this triggers `publish.yml`, which publishes to npm

Before cutting a release, make sure `CHANGELOG.md` has a complete `[Unreleased]` section describing all changes since the last tag.

## Pre-submit checklist

Before opening a PR, verify:

- [ ] `pnpm test` passes
- [ ] `pnpm run typecheck` passes
- [ ] No real keys or secrets in the diff — use test fixtures only
- [ ] Taxonomy changes include corresponding tests in `src/classify.test.ts`
- [ ] AGENTS.md updated if you changed project structure
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` for user-visible changes
- [ ] Commit message follows [Conventional Commits](https://www.conventionalcommits.org/) format

## License

Apache 2.0
