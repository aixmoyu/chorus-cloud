import {
  ProtocolConfigFileSchema,
  OverallConfigFileSchema,
  type ProtocolConfigFile,
  type OverallConfigFile,
  type ParamDef,
} from './types';
import type { ValidationIssue } from './errors';

export interface ConfigValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateProtocolConfig(data: unknown): ConfigValidationResult {
  const issues: ValidationIssue[] = [];
  const result = ProtocolConfigFileSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({
        path: issue.path.join('.'),
        reason: issue.message,
      });
    }
    return { valid: false, issues };
  }
  return { valid: true, issues: [] };
}

export function validateOverallConfig(data: unknown): ConfigValidationResult {
  const issues: ValidationIssue[] = [];
  const result = OverallConfigFileSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({
        path: issue.path.join('.'),
        reason: issue.message,
      });
    }
    return { valid: false, issues };
  }
  return { valid: true, issues: [] };
}
