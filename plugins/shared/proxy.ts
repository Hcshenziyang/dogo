import { execFile } from 'node:child_process';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { HttpsProxyAgent } from 'https-proxy-agent';

const exec = promisify(execFile);
interface ProxySettings {
  url?: string;
  bypass: string[];
  pac: boolean;
}
let cached: { expires: number; promise: Promise<ProxySettings> } | undefined;

// macOS publishes its browser proxy separately from process environment variables.
export function parseMacProxy(text: string): ProxySettings {
  const field = (key: string) =>
    text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))?.[1].trim();
  const exceptions = text.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/)?.[1] || '';
  const bypass = [...exceptions.matchAll(/^\s*\d+\s*:\s*(.+)$/gm)].map((item) => item[1].trim());
  if (field('HTTPSEnable') !== '1') return { bypass, pac: field('ProxyAutoConfigEnable') === '1' };
  const host = field('HTTPSProxy'),
    port = Number(field('HTTPSPort'));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('系统 HTTPS 代理配置无效。');
  const endpoint = isIP(host) === 6 ? `[${host}]` : host;
  const url = new URL(`http://${endpoint}:${port}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('系统 HTTPS 代理地址无效。');
  return { url: url.origin, bypass, pac: false };
}

function ipv4(value: string): number | undefined {
  if (isIP(value) !== 4) return undefined;
  return value.split('.').reduce((a, n) => ((a << 8) | Number(n)) >>> 0, 0);
}
export function bypassProxy(url: URL, entries: string[]): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.')))
    return true;
  const address = ipv4(host);
  return entries.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;
    if (rule === '<local>') return !host.includes('.') && !host.includes(':');
    const cidr = rule.match(/^([\d.]+)\/(\d{1,2})$/);
    if (cidr && address !== undefined) {
      const base = ipv4(cidr[1]),
        bits = Number(cidr[2]);
      if (base === undefined || bits > 32) return false;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (address & mask) === (base & mask);
    }
    let domain = rule,
      port = '';
    if (!rule.startsWith('[') && /^.+:\d+$/.test(rule)) [domain, port] = rule.split(':');
    if (port && Number(port) !== Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
      return false;
    if (domain.startsWith('*.')) domain = domain.slice(1);
    if (domain.startsWith('.')) return host === domain.slice(1) || host.endsWith(domain);
    return host === domain;
  });
}
async function systemSettings(): Promise<ProxySettings> {
  if (process.platform !== 'darwin') return { bypass: [], pac: false };
  if (!cached || cached.expires < Date.now()) {
    cached = {
      expires: Date.now() + 10000,
      promise: exec('/usr/sbin/scutil', ['--proxy'], { timeout: 2000 }).then((result) =>
        parseMacProxy(result.stdout),
      ),
    };
  }
  return cached.promise;
}
export async function proxyFor(target: string): Promise<string | undefined> {
  const url = new URL(target);
  if (bypassProxy(url, [])) return undefined;
  const explicit = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (explicit) {
    if (bypassProxy(url, (process.env.NO_PROXY || process.env.no_proxy || '').split(',')))
      return undefined;
    const proxy = new URL(explicit);
    if (!['http:', 'https:'].includes(proxy.protocol)) throw Error('仅支持 HTTP 或 HTTPS 代理。');
    if (proxy.username || proxy.password) throw Error('暂不支持需要认证的代理。');
    return proxy.href;
  }
  const settings = await systemSettings();
  if (
    bypassProxy(url, [
      ...settings.bypass,
      ...(process.env.NO_PROXY || process.env.no_proxy || '').split(','),
    ])
  )
    return undefined;
  if (settings.pac) throw Error('系统使用 PAC 自动代理；请为 DSH 配置 HTTPS_PROXY。');
  return settings.url;
}

// A Node Host does not automatically use the macOS browser proxy. Keep redirect
// rejection and AbortSignal behaviour identical for proxied and direct requests.
export async function proxyFetch(input: string, init: RequestInit): Promise<Response> {
  const proxy = await proxyFor(input);
  if (!proxy) return fetch(input, init);
  const url = new URL(input);
  if (url.protocol !== 'https:') throw Error('非本机服务必须使用 HTTPS。');
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : undefined;
    // Node does not enable chunked framing for DELETE automatically. Without a
    // length the server treats its JSON revision as absent (or a second request).
    if (body !== undefined) headers['content-length'] = String(body.length);
    const req = request(
      url,
      {
        method: init.method,
        headers,
        signal: init.signal || undefined,
        agent: new HttpsProxyAgent(proxy),
      },
      (res) => {
        const status = res.statusCode || 500;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(Error('不允许服务器跳转。'));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined)
              responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
          resolve(
            new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
