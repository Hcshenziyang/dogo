// Test-only transport mapping. Production still enforces HTTPS pairing origins.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => nativeFetch(typeof input === 'string'
  ? input.replace('https://relay.fixture.invalid', process.env.DOGO_FIXTURE_ORIGIN) : input, options);
