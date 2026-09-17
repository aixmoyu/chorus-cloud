import { describe, it, expect } from 'vitest';
import { renderDocker } from '../../src/engine/docker_renderer';

describe('renderDocker', () => {
  it('emits a simple service with image', () => {
    const yaml = renderDocker({ services: { app: { image: 'busybox' } } }, undefined);
    expect(yaml).toContain('image: busybox');
    expect(yaml).toContain('services:');
  });
  it('expands <GENERATED_ENV> placeholder from overrides', () => {
    const yaml = renderDocker(
      { services: { app: { environment: ['<GENERATED_ENV>'] } } },
      { env: ['A=1', 'B=2'] }
    );
    expect(yaml).toContain('- A=1');
    expect(yaml).toContain('- B=2');
  });
  it('expands <GENERATED_VOLUMES> placeholder from overrides', () => {
    const yaml = renderDocker(
      { services: { app: { volumes: ['<GENERATED_VOLUMES>'] } } },
      { volumes: ['./c:/c', '/d:/d'] }
    );
    expect(yaml).toContain('- "./c:/c"');
    expect(yaml).toContain('- "/d:/d"');
  });
  it('preserves static environment entries', () => {
    const yaml = renderDocker(
      { services: { app: { environment: ['STATIC=1', '<GENERATED_ENV>'] } } },
      { env: ['DYN=2'] }
    );
    expect(yaml).toContain('- STATIC=1');
    expect(yaml).toContain('- DYN=2');
  });
  it('renders ports as a list (with colon quoting)', () => {
    const yaml = renderDocker(
      { services: { app: { image: 'a', ports: ['443:443', '80:80'] } } },
      undefined
    );
    expect(yaml).toContain('- "443:443"');
    expect(yaml).toContain('- "80:80"');
  });
  it('quotes strings with colons when in list context', () => {
    const yaml = renderDocker(
      { services: { app: { environment: ['KEY=val', 'HOST:127.0.0.1'] } } },
      undefined
    );
    expect(yaml).toContain('- KEY=val');
    expect(yaml).toContain('- "HOST:127.0.0.1"');
  });
  it('omits env/volumes override keys when overrides is undefined', () => {
    const yaml = renderDocker(
      { services: { app: { image: 'a' } } },
      undefined
    );
    expect(yaml).not.toContain('GENERATED_ENV');
    expect(yaml).not.toContain('GENERATED_VOLUMES');
  });
  it('emits consistent YAML indentation (4-space under service)', () => {
    const yaml = renderDocker({ services: { app: { image: 'a', restart: 'unless-stopped' } } }, undefined);
    expect(yaml).toMatch(/^    image: a$/m);
    expect(yaml).toMatch(/^    restart: unless-stopped$/m);
  });
});
