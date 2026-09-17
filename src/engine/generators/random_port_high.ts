const DEFAULT_MIN = 30000;
const MAX_PORT = 65535;

/**
 * Generate a random high port in [min, 65535] (default min 30000).
 * The min bound comes from the generator spec (`random_port_high:30000`),
 * keeping proxy listen ports clear of well-known/registered services.
 */
export function randomPortHigh(minArg: string = String(DEFAULT_MIN)): number {
  const parsed = parseInt(minArg, 10);
  const min = Math.min(Math.max(Number.isNaN(parsed) ? DEFAULT_MIN : parsed, 1024), MAX_PORT);
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % (MAX_PORT - min + 1));
}
