// RESET pool — real transfer leg of the AI-signed join (join-pay.mjs).
//
// Direct-gateway mode only: the member's own signer talks to the
// official gateway (default https://reset.openmayhem.ai, overridable
// via RESET_GATEWAY_URL). Members on a hosted MCP setup cannot use
// this module — their agent's own transfer tool + join-sign.mjs is
// the split path for them, and the late-receipt backstop still applies.
//
// Acceptance discipline (mirrors the signer's own submit wrapper):
//   - gateway ok === true  -> { accepted: true }
//   - gateway ok === false -> { accepted: false, outcome: 'rejected' }
//   - anything else / transport failure -> { accepted: false,
//     outcome: 'unknown' } — the caller MUST NOT blind-retry: an
//     unknown outcome may already be accepted on the gateway side.
// A rejected or unknown outcome must never produce a receipt: the
// receipt is proof of an ACCEPTED transfer, nothing else.
import { localBackend } from '../../reset/signer/lib/local-backend.mjs';
import { signTransfer } from '../../reset/signer/lib/index.mjs';
import { publicAddress } from '../../reset/signer/lib/keystore.mjs';

export const DEFAULT_GATEWAY_URL = 'https://reset.openmayhem.ai';

export async function executeJoinTransfer({ wallet, to, amountUnits, gatewayUrl = DEFAULT_GATEWAY_URL }) {
  const me = publicAddress(wallet);
  const amount = String(amountUnits);
  const backend = localBackend({ wallet, gatewayUrl });
  try {
    const account = await backend.account();
    if (BigInt(account.balance ?? '0') < BigInt(amount)) {
      throw new Error(`insufficient spendable coins: balance ${account.balance} < transfer ${amount}`);
    }
    const packet = await backend.prepareTransfer(to, amount);
    if (packet.address !== me || packet.to !== to || packet.amount !== amount) {
      throw new Error('Gateway changed the requested transfer (address, recipient, or amount mismatch) — refusing to sign');
    }
    const signed = signTransfer(wallet, packet, { context: packet.context });
    let result;
    try { result = await backend.submitTransfer(signed); }
    catch { return { accepted: false, outcome: 'unknown', tx: packet.tx, nonce: packet.nonce }; }
    if (result?.ok === true) return { accepted: true, outcome: 'accepted', tx: packet.tx, nonce: packet.nonce, gateway: result };
    if (result?.ok === false) return { accepted: false, outcome: 'rejected', tx: packet.tx, nonce: packet.nonce, error: result.error ?? null };
    return { accepted: false, outcome: 'unknown', tx: packet.tx, nonce: packet.nonce };
  } finally {
    try { await backend.close(); } catch {}
  }
}
