import { describe, it, expect } from 'vitest';
import { resolveAndValidate } from '../../src/engine/validator';
import type { ParamDef } from '../../src/engine/types';
import { ValidationError } from '../../src/engine/errors';

describe('resolveAndValidate', () => {
  const defs: ParamDef[] = [
    { name: 'port', type: 'number', required: false, default: 443 },
    { name: 'tag', type: 'string', required: false, generator: 'hex:8' },
    { name: 'domain', type: 'string', required: false },
    { name: 'kp', type: 'string', required: false, generator: 'x25519_keypair' },
  ];

  it('applies user value when present (truthy)', () => {
    const r = resolveAndValidate(defs, { port: 8443, domain: 'x.test' });
    expect(r.port).toBe(8443);
    expect(r.domain).toBe('x.test');
  });
  it('falls back to default when user value missing', () => {
    const r = resolveAndValidate(defs, {});
    expect(r.port).toBe(443);
  });
  it('applies generator when no user value and no default', () => {
    const r = resolveAndValidate(defs, { port: 1 });
    expect(r.tag).toMatch(/^[0-9a-f]{8}$/);
    expect(r.kp).toHaveProperty('privateKey');
  });
  it('throws on missing required with no default and no generator', () => {
    const strict: ParamDef[] = [{ name: 'domain', type: 'string', required: true }];
    expect(() => resolveAndValidate(strict, {})).toThrow(ValidationError);
  });
  it('coerces user-supplied number strings to numbers when type=number', () => {
    const r = resolveAndValidate([{ name: 'port', type: 'number', required: false }], { port: '8443' });
    expect(r.port).toBe(8443);
  });
  it('records one ValidationIssue per failing param', () => {
    try {
      resolveAndValidate([
        { name: 'a', type: 'string', required: true },
        { name: 'b', type: 'number', required: true },
      ], {});
    } catch (e) {
      const ve = e as ValidationError;
      expect(ve.issues.length).toBe(2);
      expect(ve.issues.map((i) => i.path).sort()).toEqual(['a', 'b']);
      return;
    }
    throw new Error('expected throw');
  });
});