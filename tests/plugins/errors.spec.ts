import { describe, it, expect } from 'vitest';
import {
  PluginError,
  MissingParamError,
  UnknownGeneratorError,
  UnknownParamError,
  ValidationError,
} from '../../src/engine/errors';

describe('error classes', () => {
  it('PluginError is the base for all', () => {
    const e = new PluginError('PLG_TEST', 'oops');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('PLG_TEST');
    expect(e.name).toBe('PluginError');
  });
  it('MissingParamError has PLG-style code preserved', () => {
    const e = new MissingParamError('port');
    expect(e.code).toBe('PLG_MISSING_PARAM');
    expect(e.message).toContain('port');
    expect(e).toBeInstanceOf(PluginError);
  });
  it('UnknownGeneratorError includes available list', () => {
    const e = new UnknownGeneratorError('xx', ['uuid', 'hex']);
    expect(e.code).toBe('PLG_UNKNOWN_GENERATOR');
    expect(e.message).toContain('uuid');
    expect(e.message).toContain('hex');
  });
  it('UnknownParamError includes param path + available', () => {
    const e = new UnknownParamError('a.b', ['c', 'd']);
    expect(e.code).toBe('PLG_UNKNOWN_PARAM');
    expect(e.message).toContain('a.b');
  });
  it('ValidationError carries issues array', () => {
    const e = new ValidationError([{ path: 'port', reason: 'must be number' }]);
    expect(e.code).toBe('PLG_VALIDATION_FAILED');
    expect(e.issues).toEqual([{ path: 'port', reason: 'must be number' }]);
  });
});
