import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, createInstance, createNode, jsonBody, seed } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache(); // 30s shared template cache must not outlive the per-test D1 reset
});

async function deployNode(nodeId: string): Promise<{ status: number; body: any }> {
  const res = await api(`/api/deploy/${nodeId}`, { method: 'POST', headers: await adminHeaders() });
  return { status: res.status, body: await jsonBody(res) };
}

describe('POST /api/deploy/:nodeId', () => {
  it('requires auth', async () => {
    const res = await api('/api/deploy/some-node', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 404 NODE_NOT_FOUND for an unknown node', async () => {
    await seed();
    const { status, body } = await deployNode('no-such-node');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NODE_NOT_FOUND');
  });

  it('returns 400 NO_ACTIVE_PROTOCOLS when the node has no instances', async () => {
    await seed();
    const node = await createNode({ serverOverallId: 'server-default', dockerOverallId: 'docker-default' });
    const { status, body } = await deployNode(node.id);
    expect(status).toBe(400);
    expect(body.error.code).toBe('NO_ACTIVE_PROTOCOLS');
  });

  it('returns 400 NO_SERVER_OVERALL when no server template is assigned', async () => {
    await seed();
    const node = await createNode({ dockerOverallId: 'docker-default' });
    await createInstance('hysteria2', node.id, { domain: 'd.example.com' });
    const { status, body } = await deployNode(node.id);
    expect(status).toBe(400);
    expect(body.error.code).toBe('NO_SERVER_OVERALL');
  });

  it('returns 400 NO_DOCKER_OVERALL when no docker template is assigned', async () => {
    await seed();
    const node = await createNode({ serverOverallId: 'server-default' });
    await createInstance('hysteria2', node.id, { domain: 'd.example.com' });
    const { status, body } = await deployNode(node.id);
    expect(status).toBe(400);
    expect(body.error.code).toBe('NO_DOCKER_OVERALL');
  });

  it('renders the complete deploy artifact set for a fully configured node', async () => {
    await seed();
    const node = await createNode({ serverOverallId: 'server-default', dockerOverallId: 'docker-default' });
    await createInstance('hysteria2', node.id, { domain: 'deploy.example.com', port: 8443 });

    const { status, body } = await deployNode(node.id);
    expect(status).toBe(200);

    // Combined server config splices the protocol instance.
    expect(body.serverConfig.inbounds).toHaveLength(1);
    expect(body.serverConfig.inbounds[0].type).toBe('hysteria2');
    expect(JSON.stringify(body.serverConfig)).not.toContain('{{');

    // Docker artifacts.
    expect(typeof body.composeYaml).toBe('string');
    expect(body.composeYaml).toContain('services:');
    expect(typeof body.entrySh).toBe('string');

    // Per-instance client configs are returned for panel distribution.
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0].id).toBeDefined();
    expect(body.instances[0].clientConfig).toBeDefined();
    expect(body.instances[0].clientConfig.server).toBe('deploy.example.com');
  });

  it('derives docker env overrides from rendered inbound ports', async () => {
    await seed();
    // A docker template that consumes the generated env so the derived
    // SING_BOX_PORT_* entries become observable in the compose output.
    await api('/api/templates', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({
        id: 'env-docker',
        category: 'docker',
        name: 'Env Docker',
        version: '1.0.0',
        templateContent: JSON.stringify({
          services: { 'sing-box': { image: 'busybox', environment: ['<GENERATED_ENV>'] } },
        }),
      }),
    });
    const node = await createNode({ serverOverallId: 'server-default', dockerOverallId: 'env-docker' });
    await createInstance('hysteria2', node.id, { domain: 'ports.example.com', port: 8443 });

    const { status, body } = await deployNode(node.id);
    expect(status).toBe(200);
    expect(body.composeYaml).toContain('SING_BOX_PORT_8443=8443');
  });
});
