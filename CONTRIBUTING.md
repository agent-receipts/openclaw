# Contributing

Contributions are welcome! This plugin is part of the [Attest Protocol](https://github.com/agnt-rcpt) ecosystem.

## Reporting Issues

Open a GitHub issue for:

- Bugs in receipt generation or chain integrity
- Incorrect taxonomy mappings
- Missing OpenClaw tool classifications
- Documentation gaps

## Development Setup

```bash
git clone https://github.com/agnt-rcpt/openclaw.git
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

## Taxonomy Contributions

Adding mappings for new OpenClaw tools is a great way to contribute. Edit `taxonomy.json` and add corresponding tests in `src/classify.test.ts`.

## Spec Alignment

This plugin implements the [Action Receipt Protocol](https://github.com/agnt-rcpt/spec) via the `@agnt-rcpt/sdk-ts` SDK. Changes must remain compatible with the protocol specification.

## License

MIT
