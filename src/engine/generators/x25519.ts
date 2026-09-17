import { x25519 } from '@noble/curves/ed25519';

// Reality keys are raw X25519 scalars/points, base64url-encoded without
// padding — the same encoding as `sing-box generate reality-keypair`
// (base64.RawURLEncoding in Go).
function b64UrlEncode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function x25519KeyPair(): { privateKey: string; publicKey: string } {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  return { privateKey: b64UrlEncode(priv), publicKey: b64UrlEncode(pub) };
}
