-- Frozen v2 schema from pre-DDD commit 1914ab4.

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('desktop', 'mobile')),
    active INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    refresh_hash TEXT UNIQUE,
    refresh_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(account_id, id)
);
CREATE TABLE IF NOT EXISTS memos (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    project TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT NOT NULL,
    active INTEGER NOT NULL,
    created_device_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    FOREIGN KEY(account_id, created_device_id) REFERENCES devices(account_id, id),
    UNIQUE(account_id, request_id),
    UNIQUE(account_id, id)
);
CREATE INDEX IF NOT EXISTS memos_account_project ON memos(account_id, project, created_at);
CREATE TABLE IF NOT EXISTS dispatches (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    memo_id TEXT NOT NULL,
    memo_revision INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    content_snapshot TEXT NOT NULL,
    instruction TEXT NOT NULL,
    target_device_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'leased', 'accepted', 'cancelled')),
    lease_token TEXT,
    lease_until INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    accepted_at INTEGER,
    native_session_id TEXT,
    UNIQUE(account_id, request_id),
    FOREIGN KEY(account_id, memo_id) REFERENCES memos(account_id, id),
    FOREIGN KEY(account_id, target_device_id) REFERENCES devices(account_id, id)
);
CREATE INDEX IF NOT EXISTS dispatches_delivery
    ON dispatches(account_id, target_device_id, status, lease_until, created_at);
CREATE INDEX IF NOT EXISTS dispatches_memo
    ON dispatches(account_id, memo_id, created_at, id);

PRAGMA user_version=2;
