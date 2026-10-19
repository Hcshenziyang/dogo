export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class ServiceClient {
  url: string;
  token: string;
  constructor(url: string, token: string) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('Use a service origin URL without credentials, query or path');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) {
      throw new Error('Remote connections require HTTPS; use a loopback SSH tunnel for development');
    }
    if (token.length < 32) throw new Error('Device token must be at least 32 characters');
    this.url = parsed.origin;
    this.token = token;
  }

  async request<T>(path: string, method = 'GET', input?: unknown): Promise<T> {
    if (!path.startsWith('/v1/') && !path.startsWith('/v3/auth/') && !['/v2/hub', '/v2/memory'].includes(path)) throw new Error('Invalid API path');
    const response = await fetch(`${this.url}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, result.error ?? `Request failed: ${response.status}`);
    return result as T;
  }
}
