import type { ParamDef } from './types';
import { getGenerator } from './generators';
import { ValidationError, type ValidationIssue } from './errors';

function isMeaningfulDefault(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function hasUserValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function coerceByType(def: ParamDef, userValue: unknown): unknown {
  if (def.type === 'number' && typeof userValue === 'string') {
    const n = Number(userValue);
    if (!Number.isNaN(n)) return n;
  }
  return userValue;
}

export function resolveAndValidate(
  defs: ParamDef[],
  userParams: Record<string, unknown> = {},
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  const issues: ValidationIssue[] = [];

  for (const def of defs) {
    const raw = userParams[def.name];
    if (hasUserValue(raw)) {
      const coerced = coerceByType(def, raw);
      if (def.type === 'select' && def.enum && def.enum.length > 0) {
        if (!def.enum.includes(String(coerced))) {
          issues.push({ path: def.name, reason: `value '${coerced}' is not in allowed enum: [${def.enum.join(', ')}]` });
          continue;
        }
      }
      resolved[def.name] = coerced;
    } else if (isMeaningfulDefault(def.default)) {
      resolved[def.name] = def.default;
    } else if (def.generator) {
      const gen = getGenerator(def.generator.split(':')[0]);
      if (!gen) {
        issues.push({ path: def.name, reason: `generator '${def.generator}' not registered` });
        continue;
      }
      const parts = def.generator.split(':');
      const args = parts.length > 1 ? parts[1].split(',').map((s) => s.trim()) : [];
      resolved[def.name] = gen(...args);
    } else if (def.required) {
      issues.push({ path: def.name, reason: 'required param has no value, default, or generator' });
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);
  return resolved;
}
