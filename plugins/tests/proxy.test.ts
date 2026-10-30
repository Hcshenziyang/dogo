import { afterEach, describe, expect, it, vi } from 'vitest';
import { bypassProxy, parseMacProxy, proxyFor } from '../shared/proxy.js';

afterEach(() => vi.unstubAllEnvs());

describe('system proxy settings', () => {
  it('parses macOS HTTPS proxy and respects domain and private-network exceptions', () => {
    const settings = parseMacProxy(`
      <dictionary> {
        ExceptionsList : <array> {
          0 : 127.0.0.1
          1 : 192.168.0.0/16
          2 : *.local
        }
        HTTPSEnable : 1
        HTTPSPort : 7897
        HTTPSProxy : 127.0.0.1
        ProxyAutoConfigEnable : 0
      }
    `);
    expect(settings.url).toBe('http://127.0.0.1:7897');
    expect(bypassProxy(new URL('https://dogo.example.com'), settings.bypass)).toBe(false);
    expect(bypassProxy(new URL('https://192.168.1.8'), settings.bypass)).toBe(true);
    expect(bypassProxy(new URL('https://box.local'), settings.bypass)).toBe(true);
    expect(bypassProxy(new URL('http://127.0.0.1:9999'), [])).toBe(true);
    expect(bypassProxy(new URL('https://127.attacker.example'), [])).toBe(false);
  });
  it('rejects authenticated proxy URLs so proxy credentials cannot leak through debug logs', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://user:password@127.0.0.1:7897');
    vi.stubEnv('NO_PROXY', '');
    await expect(proxyFor('https://dogo.example.com')).rejects.toThrow('暂不支持需要认证的代理');
  });
  it('recognizes PAC and rejects invalid system proxy ports', () => {
    expect(parseMacProxy('ProxyAutoConfigEnable : 1\nHTTPSEnable : 0').pac).toBe(true);
    expect(() => parseMacProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 0')).toThrow();
  });
});
