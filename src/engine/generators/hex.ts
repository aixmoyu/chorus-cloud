const CHARS = 'abcdef0123456789';

function randInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

export function hex(arg: string = '16'): string {
  const n = Math.min(1024, Math.max(1, parseInt(arg, 10) || 16));
  let out = '';
  for (let i = 0; i < n; i++) out += CHARS[randInt(CHARS.length)];
  return out;
}
