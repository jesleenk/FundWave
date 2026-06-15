// Stellar network + contract addresses are read from NEXT_PUBLIC_* env vars.
// The deploy script writes these to web/.env.local on every successful deploy.
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as
  | "testnet"
  | "futurenet"
  | "mainnet"
  | "local";

export const CONTRACT_ID =
  process.env.NEXT_PUBLIC_CONTRACT_ID ?? ""; // set by scripts/deploy.sh

// Default to native XLM SAC on the chosen network. The user can also pass
// any SAC token address in the create form.
export const NATIVE_TOKEN_ADDRESS: Record<string, string> = {
  testnet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  futurenet: "CDOF6BKZ6A4FDDP4NJT4V5D4HMMZM36TQCYM4J2Y66W5YL3QYODDGKYM",
  mainnet: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  local: "CDOF6BKZ6A4FDDP4NJT4V5D4HMMZM36TQCYM4J2Y66W5YL3QYODDGKYM",
};

export const HORIZON_URL: Record<string, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
  mainnet: "https://horizon.stellar.org",
  local: "http://localhost:8000",
};

export const SOROBAN_RPC_URL: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
  local: "http://localhost:8000/soroban/rpc",
};
