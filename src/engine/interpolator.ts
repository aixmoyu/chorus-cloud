import { getGenerator } from './generators';
import { PluginError } from './errors';

const WHOLE_PLACEHOLDER = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const EMBEDDED_PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function lookupPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function resolveExpression(expr: string, params: Record<string, unknown>): unknown {
  const trimmed = expr.trim();
  if (trimmed === '') {
    throw new PluginError('PLG_INVALID_EXPRESSION', '[PLG_INVALID_EXPRESSION] Empty placeholder expression');
  }
  if (trimmed.startsWith('params.')) {
    const path = trimmed.slice('params.'.length);
    const value = lookupPath(params, path);
    if (value === undefined) {
      throw new PluginError('PLG_UNKNOWN_PARAM', `[PLG_UNKNOWN_PARAM] Template references unknown param: '${path}' (available: ${Object.keys(params).join(', ')})`);
    }
    return value;
  }
  if (trimmed.startsWith('gen.')) {
    const spec = trimmed.slice('gen.'.length);
    const colonIdx = spec.indexOf(':');
    const name = colonIdx === -1 ? spec : spec.slice(0, colonIdx);
    const argsStr = colonIdx === -1 ? '' : spec.slice(colonIdx + 1);
    const args = argsStr.split(',').map((s) => s.trim());
    const gen = getGenerator(name);
    if (!gen) {
      throw new PluginError('PLG_UNKNOWN_GENERATOR', `[PLG_UNKNOWN_GENERATOR] Unknown generator: '${name}'`);
    }
    return gen(...args);
  }
  throw new PluginError('PLG_INVALID_EXPRESSION', `[PLG_INVALID_EXPRESSION] Unknown placeholder expression: '${trimmed}' (expected 'params.X' or 'gen.NAME(:ARGS)')`);
}

function substituteInString(s: string, params: Record<string, unknown>): unknown {
  const whole = s.match(WHOLE_PLACEHOLDER);
  if (whole) return resolveExpression(whole[1], params);
  return s.replace(EMBEDDED_PLACEHOLDER, (_match, expr) => {
    const v = safeResolveEmbedded(expr, params);
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  });
}

// Placeholders handled by registry.splicePlaceholders (array-spread semantics).
// When these survive into replacePlaceholders, it means splice had no replacement —
// warn rather than silently emitting empty string.
const SPLICE_KEYWORDS = new Set(['protocols', 'proxy_tags']);

function safeResolveEmbedded(expr: string, params: Record<string, unknown>): unknown {
  try {
    return resolveExpression(expr, params);
  } catch (e) {
    if (e instanceof PluginError && (e.code === 'PLG_UNKNOWN_PARAM' || e.code === 'PLG_UNKNOWN_GENERATOR' || e.code === 'PLG_INVALID_EXPRESSION')) {
      const trimmed = expr.trim();
      if (SPLICE_KEYWORDS.has(trimmed)) {
        console.warn(`[interpolator] splice placeholder '{{ ${trimmed} }}' was not expanded (no replacement provided)`);
      } else {
        console.warn(`[interpolator] unresolved placeholder '{{ ${expr} }}': ${e.message}`);
      }
      return '';
    }
    throw e;
  }
}

export function replacePlaceholders(obj: unknown, params: Record<string, unknown>): unknown {
  if (obj == null) return obj;
  if (typeof obj === 'string') return substituteInString(obj, params);
  if (Array.isArray(obj)) {
    return obj.map((item) => {
      if (typeof item === 'string') return substituteInString(item, params);
      if (item && typeof item === 'object') return replacePlaceholders(item, params);
      return item;
    });
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof value === 'string') {
        result[key] = substituteInString(value, params);
      } else if (value && typeof value === 'object') {
        result[key] = replacePlaceholders(value, params);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return obj;
}
