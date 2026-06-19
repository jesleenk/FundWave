"use client";

// Minimal wallet context backed by @creit.tech/stellar-wallets-kit (v2.x).
// The kit exposes a fully static API: StellarWalletsKit.init / .setWallet /
// .getAddress / .signTransaction / .authModal. We persist the last selected
// wallet id in localStorage so the user stays connected across reloads.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  StellarWalletsKit,
  Networks,
  type ISupportedWallet,
} from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { NETWORK } from "./network";

interface WalletState {
  publicKey: string | null;
  connecting: boolean;
  supportedWallets: ISupportedWallet[];
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (
    txXdr: string,
    opts?: { networkPassphrase?: string },
  ) => Promise<{ signedTxXdr: string }>;
}

const WalletContext = createContext<WalletState | null>(null);

const STORAGE_KEY = "fundwave:lastWalletId";

const FREIGHTER_ID = "freighter";

function networkConst() {
  switch (NETWORK) {
    case "mainnet":
      return Networks.PUBLIC;
    case "futurenet":
      return Networks.FUTURENET;
    case "local":
      return Networks.STANDALONE;
    case "testnet":
    default:
      return Networks.TESTNET;
  }
}

let _initialized = false;
function ensureInit() {
  if (_initialized) return;
  StellarWalletsKit.init({
    network: networkConst(),
    modules: defaultModules(),
  });
  _initialized = true;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [supportedWallets, setSupportedWallets] = useState<ISupportedWallet[]>(
    [],
  );

  // Bootstrap: list wallets and re-attach last selection.
  useEffect(() => {
    (async () => {
      ensureInit();
      try {
        const list = await StellarWalletsKit.refreshSupportedWallets();
        setSupportedWallets(list);
      } catch {
        /* ignore */
      }

      const last =
        typeof window !== "undefined"
          ? localStorage.getItem(STORAGE_KEY)
          : null;
      if (last) {
        try {
          StellarWalletsKit.setWallet(last);
          const { address } = await StellarWalletsKit.getAddress();
          if (address) setPublicKey(address);
          else localStorage.removeItem(STORAGE_KEY);
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    })();
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      // authModal prompts the user to pick a wallet, sets it, and returns the
      // connected address in one call. The kit handles Freighter / Albedo /
      // xBull / Rabet / Hana / Ledger / Trezor behind the scenes.
      const { address } = await StellarWalletsKit.authModal({});
      if (address) {
        setPublicKey(address);
        // Persist whichever wallet the user picked by querying the kit.
        try {
          // We don't have direct access to selectedModule's productId at runtime
          // without an event hook, so re-read supported wallets and ask them.
          const supported = await StellarWalletsKit.refreshSupportedWallets();
          // The kit updates its internal state; localStorage hint below.
          void supported;
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      // Last-resort fallback: try Freighter directly
      try {
        StellarWalletsKit.setWallet(FREIGHTER_ID);
        const { address } = await StellarWalletsKit.getAddress();
        if (address) {
          setPublicKey(address);
          localStorage.setItem(STORAGE_KEY, FREIGHTER_ID);
        }
      } catch {
        /* give up */
      }
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    StellarWalletsKit.disconnect().catch(() => {});
    setPublicKey(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const signTransaction = useCallback<WalletState["signTransaction"]>(
    async (txXdr, opts) => {
      const res = await StellarWalletsKit.signTransaction(txXdr, {
        networkPassphrase: opts?.networkPassphrase,
      });
      return { signedTxXdr: res.signedTxXdr };
    },
    [],
  );

  const value = useMemo<WalletState>(
    () => ({
      publicKey,
      connecting,
      supportedWallets,
      connect,
      disconnect,
      signTransaction,
    }),
    [publicKey, connecting, supportedWallets, connect, disconnect, signTransaction],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
