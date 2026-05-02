# Contributing

Thanks for considering a contribution! This document covers the developer workflow. End-user documentation lives in [`README.md`](README.md).

## Prerequisites

- Node.js 18.20+ (20 or 22 recommended)
- npm 10+
- An OnlyCat account and at least one flap, if you want to run integration tests against real hardware

## Local setup

```sh
git clone https://github.com/matthiaseinig/OnlyCatHomebridge.git
cd OnlyCatHomebridge
npm install
npm run build
```

Common scripts:

| Script | What it does |
|--------|--------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run watch` | Recompile on file changes |
| `npm run lint` | Run ESLint |
| `npm run format` | Format with Prettier |
| `npm test` | Run the unit-test suite |
| `npm run test:coverage` | Run tests with coverage report (must be ≥ 95%) |
| `npm run dev` | Build, then launch a local Homebridge against `dev/` |

## Running against a real flap

The `dev/` folder holds a local Homebridge sandbox that's git-ignored. Copy the example config, fill in your token, and start the dev bridge:

```sh
cp dev/config.example.json dev/config.json
# edit dev/config.json — paste your OnlyCat API token
npm run dev
```

Pair the dev bridge to a separate "house" in the Home app, or unpair it after testing. **Never commit `dev/config.json`.** If you ever do by accident, rotate the token in the OnlyCat app immediately.

## Quality bar (enforced before commit)

We hold every commit to four rules. CI will fail if any of them break:

1. **Type-check + lint clean** — `npm run build && npm run lint`
2. **Tests pass with ≥ 95 % line and branch coverage** — `npm run test:coverage`
3. **No new vulnerabilities** — `npm audit --audit-level=high` clean, no unpinned dependencies
4. **No leaked secrets** — token, API keys, or device IDs must never appear in committed files. The `dev/` directory is git-ignored except for the example and README.

## Architecture notes

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the overall design, [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the OnlyCat Socket.IO wire format we depend on, and [`docs/ACCESSORIES.md`](docs/ACCESSORIES.md) for how OnlyCat concepts map to HomeKit services.

## Pull-request checklist

- [ ] Branch is rebased on `main`
- [ ] `npm run build`, `npm run lint`, `npm run test:coverage` all pass locally
- [ ] New code is covered by tests (≥ 95 %)
- [ ] No secrets / tokens / device IDs in the diff
- [ ] Public-facing changes documented in `README.md` or `docs/`
- [ ] `dev/config.json` is **not** in the diff

## Reporting bugs / vulnerabilities

- For bugs: open a GitHub issue with reproduction steps and Homebridge logs (with `debug: true`)
- For security issues: see [`SECURITY.md`](SECURITY.md). **Do not** open a public issue.

## License

By contributing you agree that your contributions are licensed under the MIT License.
