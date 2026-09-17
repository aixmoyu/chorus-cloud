export class PluginError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'PluginError';
  }
}

export class MissingParamError extends PluginError {
  constructor(public paramName: string) {
    super('PLG_MISSING_PARAM', `Required param missing: '${paramName}' (no value, default, or generator)`);
    this.name = 'MissingParamError';
  }
}

export class UnknownGeneratorError extends PluginError {
  constructor(public generatorName: string, public available: string[]) {
    super('PLG_UNKNOWN_GENERATOR', `Unknown generator: '${generatorName}' (registered: ${available.join(', ')})`);
    this.name = 'UnknownGeneratorError';
  }
}

export class UnknownParamError extends PluginError {
  constructor(public paramPath: string, public available: string[]) {
    super('PLG_UNKNOWN_PARAM', `Template references unknown param: '${paramPath}' (available: ${available.join(', ')})`);
    this.name = 'UnknownParamError';
  }
}

export interface ValidationIssue {
  path: string;
  reason: string;
}

export class ValidationError extends PluginError {
  constructor(public issues: ValidationIssue[]) {
    super('PLG_VALIDATION_FAILED', `Validation failed: ${issues.map((i) => `${i.path}: ${i.reason}`).join('; ')}`);
    this.name = 'ValidationError';
  }
}
