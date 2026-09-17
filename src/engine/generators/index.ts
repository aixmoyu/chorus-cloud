import { uuid } from './uuid';
import { hex } from './hex';
import { x25519KeyPair } from './x25519';
import { randomPort, randomPortHigh } from './random_port';
import { nowIso } from './now_iso';
import { randomTag } from './random_tag';

export type GeneratorFn = (...args: string[]) => unknown;

const registry = new Map<string, GeneratorFn>();

export function registerGenerator(name: string, fn: GeneratorFn): void {
  registry.set(name, fn);
}

export function unregisterGenerator(name: string): boolean {
  return registry.delete(name);
}

export function getGenerator(name: string): GeneratorFn | undefined {
  return registry.get(name);
}

export function getRegisteredGenerators(): string[] {
  return Array.from(registry.keys());
}

// Built-in generators — registered once at module load.
// Custom generators can be added at runtime via registerGenerator().
registerGenerator('uuid', () => uuid());
registerGenerator('hex', (arg: string = '16') => hex(arg));
registerGenerator('x25519_keypair', () => x25519KeyPair());
registerGenerator('random_port', () => randomPort());
registerGenerator('random_port_high', (min: string = '30000') => randomPortHigh(min));
registerGenerator('now_iso', () => nowIso());
registerGenerator('random_tag', (prefix: string = 'node') => randomTag(prefix));

// Backward-compat accessor: `generators.NAME(...args)` forwards to the registry.
export const generators = new Proxy({} as Record<string, GeneratorFn>, {
  get: (_target, prop: string) => registry.get(prop),
});
