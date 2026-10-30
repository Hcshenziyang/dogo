import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxyFetch } from '../shared/proxy.js';

const trust = vi.hoisted(() => ({ ca: '' }));
vi.mock('node:https', async (importOriginal) => {
  const https = await importOriginal<typeof import('node:https')>();
  return {
    ...https,
    // Trust only the temporary test certificate; exercise real TLS and CONNECT.
    request: (url: URL, options: any, callback: any) =>
      https.request(url, { ...options, ca: trust.ca }, callback),
  };
});

describe('JSON requests through an HTTPS proxy', () => {
  let directory: string;
  let origin: ReturnType<typeof createHttpsServer>;
  let proxy: ReturnType<typeof createHttpServer>;
  let endpoint: string;
  let proxyURL: string;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'dogo-proxy-test-'));
    const cert = join(directory, 'cert.pem');
    const key = join(directory, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=dogo.test',
        '-addext',
        'subjectAltName=DNS:dogo.test',
      ],
      { stdio: 'ignore' },
    );
    trust.ca = readFileSync(cert, 'utf8');
    origin = createHttpsServer({ key: readFileSync(key), cert: trust.ca }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        // Like FastAPI, a memo deletion requires its revision in the JSON body.
        res.statusCode = req.url === '/api/memos/memo' && !body ? 422 : 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ method: req.method, body, length: req.headers['content-length'] }),
        );
      });
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const originPort = (origin.address() as AddressInfo).port;
    endpoint = `https://dogo.test:${originPort}`;
    proxy = createHttpServer();
    proxy.on('connection', track);
    proxy.on('connect', (req, client, head) => {
      if (req.url !== `dogo.test:${originPort}`) return client.destroy();
      const upstream = track(
        connect(originPort, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          client.pipe(upstream).pipe(client);
        }),
      );
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyURL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [origin, proxy]
        .filter(Boolean)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['DELETE', '/api/memos/memo', { revision: 2 }],
    ['POST', '/api/memos', { request_id: 'new', content: '午饭 35 元 🍜' }],
    ['PUT', '/api/memos/memo', { revision: 2, content: '更新备忘录' }],
    ['DELETE', '/api/devices/device', undefined],
  ])('delivers the %s %s body intact', async (method, path, data) => {
    vi.stubEnv('HTTPS_PROXY', proxyURL);
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const body = data === undefined ? undefined : JSON.stringify(data);
    const response = await proxyFetch(endpoint + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(3000),
    });
    const received = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(received.method).toBe(method);
    expect(received.body).toBe(body ?? '');
    if (body !== undefined) expect(received.length).toBe(String(Buffer.byteLength(body)));
  });
});
