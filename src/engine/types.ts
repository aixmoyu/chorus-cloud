import { z } from 'zod';

export const ParamDefSchema = z.object({
  name: z.string().min(1, 'Param name must not be empty'),
  type: z.enum(['string', 'number', 'boolean', 'select', 'object']),
  required: z.boolean().optional().default(false),
  default: z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown())]).optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  generator: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.default !== undefined && data.generator !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['generator'],
      message: `Param '${data.name}': 'default' and 'generator' are mutually exclusive`,
    });
  }
  if (data.default === undefined && data.generator === undefined && !data.required) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['required'],
      message: `Param '${data.name}': must have 'default', 'generator', or 'required: true'`,
    });
  }
});

export type ParamDef = z.infer<typeof ParamDefSchema>;

export const ProtocolConfigFileSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  params: z.array(ParamDefSchema),
  description: z.string().optional(),
});

export type ProtocolConfigFile = z.infer<typeof ProtocolConfigFileSchema>;

export const OverallConfigFileSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  params: z.array(ParamDefSchema),
  description: z.string().optional(),
});

export type OverallConfigFile = z.infer<typeof OverallConfigFileSchema>;

// Unified template categories (migration 0008)
export const TEMPLATE_CATEGORIES = ['protocol', 'overall-server', 'overall-client', 'overall-docker'] as const;
export type TemplateCategory = typeof TEMPLATE_CATEGORIES[number];

export const OVERALL_CATEGORIES = ['overall-server', 'overall-client', 'overall-docker'] as const;
export type OverallCategory = typeof OVERALL_CATEGORIES[number];

// Unified Template schema (covers both protocol and overall templates)
export const TemplateSchema = z.object({
  id: z.string(),
  category: z.enum(TEMPLATE_CATEGORIES),
  name: z.string(),
  version: z.string(),
  serverTemplate: z.string().optional(),
  clientTemplate: z.string().optional(),
  templateContent: z.string().optional(),
  config: z.string().optional(),
  entryScript: z.string().optional(),
  params: z.string(),
  description: z.string().optional(),
});

export type Template = z.infer<typeof TemplateSchema>;

// Legacy aliases for backward compatibility with existing code
export type Protocol = Omit<Template, 'category' | 'templateContent' | 'config' | 'entryScript'> & {
  category: 'protocol';
  serverTemplate: string;
  clientTemplate: string;
};

export type OverallTemplate = Omit<Template, 'serverTemplate' | 'clientTemplate' | 'params'> & {
  category: OverallCategory;
  templateContent: string;
};

export const ProtocolInstanceSchema = z.object({
  id: z.string(),
  protocolId: z.string(),
  nodeId: z.string(),
  params: z.string(),
  serverConfig: z.string().optional(),
  clientConfig: z.string().optional(),
  status: z.string(),
});

export type ProtocolInstance = z.infer<typeof ProtocolInstanceSchema>;

export interface TemplateRow {
  id: string;
  category: string;
  name: string;
  version: string;
  server_template: string | null;
  client_template: string | null;
  template_content: string | null;
  config: string | null;
  entry_script: string | null;
  params: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProtocolInstanceRow {
  id: string;
  protocol_id: string;
  node_id: string;
  params: string;
  server_config: string | null;
  client_config: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionRow {
  id: string;
  name: string;
  path: string;
  overall_template_id: string | null;
  overall_params: string;
  token: string;
  active: string;
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: string;
  name: string;
  path: string;
  overallTemplateId: string | null;
  overallParams: string;
  token: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export function parseSubscriptionRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    overallTemplateId: row.overall_template_id ?? null,
    overallParams: row.overall_params,
    token: row.token,
    active: row.active === '1',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseTemplateRow(row: TemplateRow): Template {
  return TemplateSchema.parse({
    id: row.id,
    category: row.category as TemplateCategory,
    name: row.name,
    version: row.version,
    serverTemplate: row.server_template ?? undefined,
    clientTemplate: row.client_template ?? undefined,
    templateContent: row.template_content ?? undefined,
    config: row.config ?? undefined,
    entryScript: row.entry_script ?? undefined,
    params: row.params,
    description: row.description ?? undefined,
  });
}

export function parseProtocolInstanceRow(row: ProtocolInstanceRow): ProtocolInstance {
  return ProtocolInstanceSchema.parse({
    id: row.id,
    protocolId: row.protocol_id,
    nodeId: row.node_id,
    params: row.params,
    serverConfig: row.server_config ?? undefined,
    clientConfig: row.client_config ?? undefined,
    status: row.status,
  });
}
