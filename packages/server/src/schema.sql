CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  uses_remaining INTEGER NOT NULL,
  max_uses INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  ed25519_public_key TEXT NOT NULL UNIQUE,
  x25519_public_key TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL UNIQUE,
  host_device_id TEXT NOT NULL REFERENCES devices(device_id),
  guest_device_id TEXT REFERENCES devices(device_id),
  host_stake JSONB NOT NULL,
  guest_stake JSONB,
  host_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  guest_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  match_id TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  match_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  device_a TEXT NOT NULL,
  device_b TEXT NOT NULL,
  commitment TEXT NOT NULL,
  server_seed_hex TEXT NOT NULL,
  entropy_a TEXT,
  entropy_b TEXT,
  status TEXT NOT NULL,
  winner_device_id TEXT,
  settled BOOLEAN NOT NULL DEFAULT FALSE,
  state JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS stakes (
  stake_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(match_id),
  spec JSONB NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  owner_device_id TEXT NOT NULL,
  winner_device_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  calls_remaining INTEGER NOT NULL,
  active_concurrency INTEGER NOT NULL DEFAULT 0,
  online_ms_remaining BIGINT NOT NULL,
  owner_online BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT NOT NULL,
  version INTEGER NOT NULL,
  stake_id TEXT NOT NULL UNIQUE REFERENCES stakes(stake_id),
  last_online_tick_at BIGINT
);

CREATE TABLE IF NOT EXISTS inferences (
  grant_id TEXT NOT NULL REFERENCES grants(grant_id),
  inference_id TEXT NOT NULL,
  requester_device_id TEXT NOT NULL,
  owner_device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  deducted BOOLEAN NOT NULL,
  request_hash TEXT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  terminal_reason TEXT,
  PRIMARY KEY (grant_id, inference_id)
);

CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(match_id),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (match_id, seq)
);

INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
