#!/usr/bin/env bash
# Build + deploy the FundWave Soroban contract.
#
# Follows the official "Deploy to Testnet" guide:
#   https://developers.stellar.org/docs/build/smart-contracts/getting-started/deploy-to-testnet
#
# Usage:
#   ./scripts/deploy.sh                              # build + deploy to testnet
#   ./scripts/deploy.sh --network futurenet          # deploy to futurenet
#   ./scripts/deploy.sh --source-account alice       # use / create a named identity
#   ./scripts/deploy.sh --reset                      # call init() after deploy
#   ./scripts/deploy.sh --invoke hello --to RPC      # invoke a function after deploy
#   ./scripts/deploy.sh --alias fundwave             # name the deployment (default: fundwave)
#
# Required tools: stellar, cargo, rustup target wasm32-unknown-unknown
set -euo pipefail

# --- defaults -----------------------------------------------------------------
NETWORK="testnet"
SOURCE_ACCOUNT=""        # name of the stellar identity to use
CONTRACT_ALIAS="fundwave"
CONTRACT_NAME="fundwave"
RESET="false"
INVOKE_FN=""
INVOKE_ARGS=()
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_DIR="$ROOT_DIR/contracts/$CONTRACT_NAME"
ARTIFACTS_DIR="$ROOT_DIR/.soroban/artifacts"
ENV_FILE="$ROOT_DIR/web/.env.local"

# --- usage -------------------------------------------------------------------
usage() {
  sed -n '2,16p' "$0"
}

# --- arg parsing -------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)         NETWORK="$2"; shift 2 ;;
    --source-account)  SOURCE_ACCOUNT="$2"; shift 2 ;;
    --identity)        SOURCE_ACCOUNT="$2"; shift 2 ;;   # deprecated alias
    --alias)           CONTRACT_ALIAS="$2"; shift 2 ;;
    --reset)           RESET="true"; shift ;;
    --invoke)
      INVOKE_FN="$2"; shift 2
      # collect remaining args until next flag or end
      while [[ $# -gt 0 && "$1" != --* ]]; do INVOKE_ARGS+=("$1"); shift; done
      ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

# Default identity: the CLI's default, or "alice" to match the docs.
if [[ -z "$SOURCE_ACCOUNT" ]]; then
  SOURCE_ACCOUNT="alice"
fi

# --- preflight ---------------------------------------------------------------
echo ">> Preflight checks"
command -v stellar >/dev/null || { echo "stellar CLI not found" >&2; exit 1; }
command -v cargo   >/dev/null || { echo "cargo not found" >&2; exit 1; }
if ! rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
  echo ">> Adding wasm32 target"
  rustup target add wasm32-unknown-unknown
fi

# --- 1. Configure a source account -------------------------------------------
# From the guide: "stellar keys generate alice --network testnet --fund"
# Friendbot only works on testnet; for futurenet we fund via the SDF faucet.
if stellar keys ls 2>/dev/null | grep -qw "$SOURCE_ACCOUNT"; then
  echo ">> Using existing identity: $SOURCE_ACCOUNT"
else
  echo ">> Generating identity: $SOURCE_ACCOUNT"
  if [[ "$NETWORK" == "testnet" ]]; then
    stellar keys generate "$SOURCE_ACCOUNT" --network testnet --fund
  else
    stellar keys generate "$SOURCE_ACCOUNT" --network "$NETWORK"
    echo "   Fund it manually for $NETWORK, e.g.:"
    echo "     stellar keys fund $SOURCE_ACCOUNT --network $NETWORK"
  fi
fi

ACCOUNT_ADDRESS="$(stellar keys address "$SOURCE_ACCOUNT")"
echo ">> Source account: $ACCOUNT_ADDRESS"

# --- 2. Build the contract wasm ---------------------------------------------
echo ">> Building contract: $CONTRACT_NAME"
mkdir -p "$ARTIFACTS_DIR"
(
  cd "$CONTRACT_DIR"
  cargo build --target wasm32-unknown-unknown --release
)
WASM_SRC="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/${CONTRACT_NAME}.wasm"
WASM_OPT="$ARTIFACTS_DIR/${CONTRACT_NAME}.wasm"
cp "$WASM_SRC" "$WASM_OPT"
WASM_BYTES="$(wc -c < "$WASM_OPT" | tr -d ' ')"
echo ">> Wasm: $WASM_OPT ($WASM_BYTES bytes)"

# --- 3. Deploy ---------------------------------------------------------------
# From the guide: stellar contract deploy --wasm … --source-account alice \
#                       --network testnet --alias hello_world
echo ">> Deploying to $NETWORK"
DEPLOY_OUT="$(stellar contract deploy \
  --wasm "$WASM_OPT" \
  --source-account "$SOURCE_ACCOUNT" \
  --network "$NETWORK" \
  --alias "$CONTRACT_ALIAS")"
# When --alias is used, the CLI prints two lines: the id and the alias file path.
# The contract id is the line that starts with "C".
CONTRACT_ID="$(printf '%s\n' "$DEPLOY_OUT" | awk '/^C[A-Z0-9]{55,}/{print; exit}')"
if [[ -z "$CONTRACT_ID" ]]; then
  CONTRACT_ID="$(printf '%s\n' "$DEPLOY_OUT" | tail -n 1 | tr -d '[:space:]')"
fi
echo ">> Contract ID: $CONTRACT_ID"

# --- 4. Optional post-deploy actions ----------------------------------------
if [[ "$RESET" == "true" ]]; then
  echo ">> Calling init()"
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- init
fi

if [[ -n "$INVOKE_FN" ]]; then
  echo ">> Invoking $INVOKE_FN ${INVOKE_ARGS[*]:-}"
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- "$INVOKE_FN" "${INVOKE_ARGS[@]}"
fi

# --- 5. Emit env file for the web app ---------------------------------------
mkdir -p "$(dirname "$ENV_FILE")"
cat > "$ENV_FILE" <<ENV
# Auto-generated by scripts/deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
NEXT_PUBLIC_NETWORK=$NETWORK
NEXT_PUBLIC_CONTRACT_ID=$CONTRACT_ID
NEXT_PUBLIC_TOKEN_ADDRESS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
ENV

echo ""
echo "✓ Deployed $CONTRACT_NAME → $CONTRACT_ID (network: $NETWORK)"
echo "  Alias:    $CONTRACT_ALIAS  (try: stellar contract invoke --alias $CONTRACT_ALIAS -- --help)"
echo "  Env file: $ENV_FILE"
