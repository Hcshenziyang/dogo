-- Schema from the SQLx-based Rust service, kept as a compatibility fixture.
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
CREATE TABLE memos (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_device_id TEXT NOT NULL REFERENCES devices(id),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE(account_id, request_id)
);
CREATE INDEX memos_account ON memos(account_id, id);

PRAGMA application_id = 1146046287;
PRAGMA user_version = 1;
