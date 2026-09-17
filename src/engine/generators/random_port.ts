export function randomPort(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return 1024 + (buf[0] % (65535 - 1024 + 1));
}

/** High-port variant: random port in [min, 65535] (min defaults to 30000). */
export function randomPortHigh(min: string = '30000'): number {
  const lo = Math.min(Math.max(parseInt(min, 10) || 30000, 1024), 65535);
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return lo + (buf[0] % (65535 - lo + 1));
}
