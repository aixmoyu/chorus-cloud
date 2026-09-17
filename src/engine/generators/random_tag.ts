const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TAG_SUFFIX_LEN = 6;

/**
 * Generate a protocol-tag name like `hy2-x7k2m9` / `vless-a93f0b`.
 * The prefix comes from the generator spec (`random_tag:hy2`); the suffix is
 * a random alphanumeric string, unique enough per render call.
 */
export function randomTag(prefix: string = 'node'): string {
  const buf = new Uint8Array(TAG_SUFFIX_LEN);
  crypto.getRandomValues(buf);
  let suffix = '';
  for (let i = 0; i < TAG_SUFFIX_LEN; i++) {
    suffix += TAG_ALPHABET[buf[i] % TAG_ALPHABET.length];
  }
  return `${prefix}-${suffix}`;
}
