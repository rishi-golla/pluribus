import { BaseSignerWalletAdapter, WalletNotConnectedError, WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { Keypair, type Transaction, type VersionedTransaction } from "@solana/web3.js";

export const DEMO_WALLET = "Demo wallet" as WalletName<"Demo wallet">;
const STORAGE_KEY = "pluribus-demo-wallet";

// A keypair kept in localStorage, so the app can be driven with no browser extension
export class DemoWalletAdapter extends BaseSignerWalletAdapter<"Demo wallet"> {
  name = DEMO_WALLET;
  url = "";
  icon = "";
  readyState = typeof window === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Loadable;
  supportedTransactionVersions = new Set(["legacy", 0] as const);
  connecting = false;
  private keypair: Keypair | null = null;

  get publicKey() {
    return this.keypair?.publicKey ?? null;
  }

  async connect() {
    // Real wallets answer later, and the provider only hears a connect event that arrives after its effects have settled
    await Promise.resolve();
    if (this.keypair) return;
    const saved = localStorage.getItem(STORAGE_KEY);
    this.keypair = saved ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))) : Keypair.generate();
    if (!saved) localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.keypair.secretKey]));
    this.emit("connect", this.keypair.publicKey);
  }

  async disconnect() {
    // The provider also calls this on unmount, and an event from an idle wallet would make it forget the selection
    if (!this.keypair) return;
    this.keypair = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    if (!this.keypair) throw new WalletNotConnectedError();
    if ("version" in transaction) transaction.sign([this.keypair]);
    else transaction.partialSign(this.keypair);
    return transaction;
  }
}
