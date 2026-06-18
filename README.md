# FundWave

A crowdfunding / donation platform built on **Stellar** (Soroban smart contracts) with a clean, fast **Next.js** frontend.

## Features

- Create fundraising campaigns with a goal, deadline, and description.
- Anyone can donate (XLM or any SAC token) to a campaign.
- **Real-time progress**: live progress bars powered by Soroban events + polling.
- Automatic finalization: if goal is met by deadline, creator can withdraw; otherwise donors can claim refunds.
- Wallet integration via [Freighter](https://www.freighter.app/).

## Repository layout

```
fundwave/
├── contracts/fundwave/   # Soroban smart contract (Rust)
├── web/                  # Next.js frontend
├── scripts/              # build / deploy / setup helpers
├── .soroban/             # deployment records (checked in)
└── .github/workflows/    # CI (type-check + contract build)
```

## Quick start

### 1. Install contract deps

```bash
cd contracts/fundwave
cargo build --target wasm32-unknown-unknown --release
```

### 2. One-click deploy

```bash
# from repo root
pnpm deploy                  # build + deploy to testnet
pnpm deploy:reset            # + call init() after deploy
pnpm deploy:futurenet        # deploy to futurenet
# or the raw script:
./scripts/deploy.sh --invoke hello --to RPC   # post-deploy invoke
```

The script follows the official [Stellar "Deploy to Testnet" guide](https://developers.stellar.org/docs/build/smart-contracts/getting-started/deploy-to-testnet):
1. Generates a `stellar` identity (defaults to `alice`) and funds it via Friendbot.
2. Builds `target/wasm32-unknown-unknown/release/fundwave.wasm`.
3. Deploys with `--source-account` / `--network` / `--alias fundwave`, saving the alias to
   `~/.config/stellar/contract-ids/fundwave.json`.
4. Writes the contract id to `web/.env.local` for the web app to pick up.

### 3. Run the web app

```bash
cd web
pnpm install
pnpm dev
```

Open <http://localhost:3000>.

## Current deployment (testnet)

- **Contract id:** `CDODWKI67WDYCEBFSIPDDRTWTCNA5QNOB6FPMTU32LZZ5KSSWCFOO3IL`
- **Source account:** `GD7UEGTSGE4WKXZZQBHZCHXZGMTCSLAMWCAD7WJGSWGUS3TZGJGLTCNE` (identity: `alice`)
- **Lab:** <https://lab.stellar.org/r/testnet/contract/CDODWKI67WDYCEBFSIPDDRTWTCNA5QNOB6FPMTU32LZZ5KSSWCFOO3IL>

Full record (tx hashes, wasm hash, timestamps) lives in [`.soroban/deployments.json`](.soroban/deployments.json). Re-run `pnpm deploy` to refresh.

## CI

GitHub Actions runs on every push / PR:

- `web`: `pnpm typecheck`, `pnpm lint`, `pnpm build`
- `contracts/fundwave`: `cargo test --locked` + `cargo build --release --target wasm32-unknown-unknown`

See `.github/workflows/ci.yml`.

## License

MIT
