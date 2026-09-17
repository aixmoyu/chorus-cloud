import { describe, it, expect } from 'vitest';
import { replacePlaceholders, resolveExpression } from '../../src/engine/interpolator';

describe('resolveExpression', () => {
  it('resolves params.<path>', () => {
    expect(resolveExpression('params.port', { port: 443 })).toBe(443);
    expect(resolveExpression('params.realityKeyPair.privateKey', { realityKeyPair: { privateKey: 'abc' } })).toBe('abc');
  });
  it('resolves gen.NAME(:ARGS)', () => {
    const out = resolveExpression('gen.uuid', {});
    expect(typeof out).toBe('string');
    expect(out).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveExpression('gen.hex:8', {})).toMatch(/^[0-9a-f]{8}$/);
  });
  it('throws on unknown expression', () => {
    expect(() => resolveExpression('bogus.x', {})).toThrow(/PLG_INVALID_EXPRESSION/);
    expect(() => resolveExpression('', {})).toThrow(/PLG_INVALID_EXPRESSION/);
  });
  it('throws on missing param', () => {
    expect(() => resolveExpression('params.nope', { port: 1 })).toThrow(/PLG_UNKNOWN_PARAM/);
  });
  it('throws on unknown generator', () => {
    expect(() => resolveExpression('gen.nope', {})).toThrow(/PLG_UNKNOWN_GENERATOR/);
  });
});

describe('replacePlaceholders', () => {
  it('preserves types for whole-string placeholders', () => {
    expect(replacePlaceholders('{{ params.port }}', { port: 443 })).toBe(443);
    expect(replacePlaceholders('{{ params.flag }}', { flag: true })).toBe(true);
    expect(replacePlaceholders('{{ params.kp }}', { kp: { a: 1 } })).toEqual({ a: 1 });
  });
  it('embeds objects as JSON when mixed in a string', () => {
    expect(replacePlaceholders('kp={{ params.kp }}', { kp: { x: 1 } })).toBe('kp={"x":1}');
  });
  it('replaces null/undefined as empty string in embedded context', () => {
    expect(replacePlaceholders('x={{ params.nope }}', {})).toBe('x=');
  });
  it('walks arrays and objects recursively', () => {
    const tpl = { a: '{{ params.x }}', b: [{ c: '{{ params.y }}' }], d: 'static' };
    expect(replacePlaceholders(tpl, { x: 1, y: 'z' })).toEqual({ a: 1, b: [{ c: 'z' }], d: 'static' });
  });
  it('applies generator results to params before interpolation (via gen.X path)', () => {
    const out = replacePlaceholders('{{ gen.uuid }}', {});
    expect(typeof out).toBe('string');
  });
  it('keeps static text untouched', () => {
    expect(replacePlaceholders('hello world', {})).toBe('hello world');
  });
});
