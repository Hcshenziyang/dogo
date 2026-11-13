CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('desktop', 'mobile')),
    active INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    refresh_hash TEXT UNIQUE,
    refresh_expires_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX devices_account ON devices(account_id);
