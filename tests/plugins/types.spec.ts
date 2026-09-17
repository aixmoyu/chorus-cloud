import { describe, it, expect } from 'vitest';
import {
  TemplateSchema,
  ProtocolInstanceSchema,
  ParamDefSchema,
} from '../../src/engine/types';

describe('ParamDefSchema', () => {
  it('validates a complete param definition', () => {
    const param = {
      name: 'domain',
      type: 'string',
      required: true,
      description: 'Server domain',
      placeholder: 'example.com',
    };
    expect(ParamDefSchema.parse(param)).toEqual({
      ...param,
      required: true,
    });
  });

  it('defaults required to false', () => {
    const param = {
      name: 'port',
      type: 'number',
      default: 443,
    };
    const result = ParamDefSchema.parse(param);
    expect(result.required).toBe(false);
  });

  it('validates param with generator', () => {
    const param = {
      name: 'uuid',
      type: 'string',
      required: false,
      generator: 'uuid',
    };
    expect(ParamDefSchema.parse(param).generator).toBe('uuid');
  });

  it('validates param with enum (select type)', () => {
    const param = {
      name: 'domainStrategy',
      type: 'select',
      enum: ['AsIs', 'IPIfNonMatch', 'IPOnResolve'],
      required: true,
    };
    expect(ParamDefSchema.parse(param).enum).toEqual(['AsIs', 'IPIfNonMatch', 'IPOnResolve']);
  });
});

describe('TemplateSchema (protocol category)', () => {
  it('validates a protocol definition with server/client templates', () => {
    const def = {
      id: 'vless-reality-vision',
      category: 'protocol',
      name: 'VLESS Reality Vision',
      version: '1.0.0',
      serverTemplate: '{"type":"vless","tag":"{{ params.tag }}"}',
      clientTemplate: '{"type":"vless","server":"{{ params.domain }}"}',
      params: JSON.stringify([
        { name: 'domain', type: 'string', required: true },
        { name: 'port', type: 'number', default: 443 },
      ]),
      description: 'VLESS protocol with Reality TLS',
    };
    const result = TemplateSchema.parse(def);
    expect(result.id).toBe('vless-reality-vision');
    expect(result.serverTemplate).toBeDefined();
    expect(result.clientTemplate).toBeDefined();
    expect(result.category).toBe('protocol');
  });
});

describe('TemplateSchema (overall categories)', () => {
  it('validates a server overall template', () => {
    const tmpl = {
      id: 'server-default',
      category: 'overall-server',
      name: 'Default Server',
      version: '1.0.0',
      templateContent: '{"inbounds":"{{ protocols }}"}',
      config: '{"params":[]}',
      params: '[]',
    };
    expect(TemplateSchema.parse(tmpl).category).toBe('overall-server');
  });

  it('validates a docker template with entryScript', () => {
    const tmpl = {
      id: 'docker-default',
      category: 'overall-docker',
      name: 'Default Docker',
      version: '1.0.0',
      templateContent: '{"services":{}}',
      entryScript: '#!/bin/sh\nsing-box run',
      params: '[]',
    };
    const result = TemplateSchema.parse(tmpl);
    expect(result.entryScript).toBeDefined();
    expect(result.category).toBe('overall-docker');
  });

  it('validates a client overall template', () => {
    const tmpl = {
      id: 'client-default',
      category: 'overall-client',
      name: 'Default Client',
      version: '1.0.0',
      templateContent: '{"outbounds":[]}',
      config: '{"params":[]}',
      params: '[]',
    };
    expect(TemplateSchema.parse(tmpl).category).toBe('overall-client');
  });

  it('rejects invalid category', () => {
    const tmpl = {
      id: 'bad',
      category: 'invalid',
      name: 'Bad',
      version: '1.0.0',
      params: '[]',
    };
    expect(() => TemplateSchema.parse(tmpl)).toThrow();
  });
});

describe('ProtocolInstanceSchema', () => {
  it('validates a protocol instance', () => {
    const inst = {
      id: 'uuid-123',
      protocolId: 'vless-reality-vision',
      nodeId: 'node-456',
      params: '{"port":443}',
      status: 'active',
    };
    const result = ProtocolInstanceSchema.parse(inst);
    expect(result.status).toBe('active');
    expect(result.serverConfig).toBeUndefined();
  });
});
