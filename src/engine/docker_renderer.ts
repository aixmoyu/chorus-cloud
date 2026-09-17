export interface DockerOverrides {
  env?: string[];
  volumes?: string[];
}

const GEN_ENV = '<GENERATED_ENV>';
const GEN_VOLUMES = '<GENERATED_VOLUMES>';

function needsYamlQuote(s: string, inList: boolean): boolean {
  if (inList) {
    if (s.includes(':')) return true;
    if (/^\s|\s$/.test(s)) return true;
  }
  if (s === '' || s === 'true' || s === 'false' || s === 'null') return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/[:#@&*!|>'"%`]/.test(s)) return true;
  return false;
}

function quoteIfNeeded(value: unknown, inList: boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  const s = String(value);
  return needsYamlQuote(s, inList) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function renderListValue(v: unknown): string {
  return `- ${quoteIfNeeded(v, true)}`;
}

function renderList(arr: unknown[] | undefined, indent: string): string[] {
  if (!arr || arr.length === 0) return [];
  return arr.map((v) => `${indent}${renderListValue(v)}`);
}

function renderScalar(v: unknown, indent: string, inList = false): string {
  return `${indent}${quoteIfNeeded(v, inList)}`;
}

function expandPlaceholders(arr: unknown[] | undefined, overrides: DockerOverrides): unknown[] | undefined {
  if (!arr) return arr;
  const out: unknown[] = [];
  for (const item of arr) {
    if (item === GEN_ENV) {
      // Expand to override values, or drop if none provided (never leave the literal)
      if (overrides.env) out.push(...overrides.env);
    } else if (item === GEN_VOLUMES) {
      if (overrides.volumes) out.push(...overrides.volumes);
    } else {
      out.push(item);
    }
  }
  return out;
}

function renderServices(services: Record<string, Record<string, unknown>>, overrides: DockerOverrides): string[] {
  const lines: string[] = ['services:'];
  for (const [name, svc] of Object.entries(services)) {
    lines.push(`  ${name}:`);
    const expanded: Record<string, unknown> = { ...svc };
    if (Array.isArray(expanded.environment)) {
      expanded.environment = expandPlaceholders(expanded.environment as unknown[], overrides);
    }
    if (Array.isArray(expanded.volumes)) {
      expanded.volumes = expandPlaceholders(expanded.volumes as unknown[], overrides);
    }
    for (const [k, v] of Object.entries(expanded)) {
      if (Array.isArray(v)) {
        if (v.length === 0) continue;
        lines.push(`    ${k}:`);
        for (const line of renderList(v as unknown[], '      ')) lines.push(line);
      } else if (v && typeof v === 'object') {
        lines.push(`    ${k}:`);
        for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
          lines.push(`      ${kk}: ${quoteIfNeeded(vv, false)}`);
        }
      } else {
        lines.push(renderScalar(v, `    ${k}: `, false));
      }
    }
  }
  return lines;
}

export function renderDocker(
  compose: Record<string, unknown>,
  overrides: DockerOverrides | undefined,
): string {
  const safeOverrides = overrides ?? {};
  const lines: string[] = [];
  if (compose.services && typeof compose.services === 'object') {
    for (const l of renderServices(compose.services as Record<string, Record<string, unknown>>, safeOverrides)) {
      lines.push(l);
    }
  }
  for (const [k, v] of Object.entries(compose)) {
    if (k === 'services') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const line of renderList(v as unknown[], '  ')) lines.push(line);
    } else {
      lines.push(`${k}: ${quoteIfNeeded(v, false)}`);
    }
  }
  return lines.join('\n') + '\n';
}
