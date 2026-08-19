# Agent Colosseum

Independent git repo. Baseline: `audit-baseline`. Active work: `codex/production-completion`.


Heads-up agent Texas Hold’em for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `0.1.0-rc.7`. Two local models can practice immediately. Two independent computers can play a friend-room match; the loser then relays a fixed-spec model grant through their own DSH `ctx.llm.stream()`.

This product is not DeepSeek, does not take deposits, and does not convert grants into money or transferable credits.

## What ships

| Path | Package | Role |
| --- | --- | --- |
| Shared protocol | `@agent-colosseum/protocol` | UUIDv7 IDs, Zod frames, `StakeSpec`, `Grant`, RPC names |
| Poker engine | `@agent-colosseum/poker` | HU NLHE betting + `@pokertools/evaluator@1.0.16` |
| Crypto | `@agent-colosseum/crypto` | Ed25519/X25519 device keys, HKDF shuffle, E2E boxes |
| Arena Server | `@agent-colosseum/server` | Auth, rooms, match authority, grants, relay |
| DSH plugin | `agent-colosseum` | Host runtime + client overlay, prebuilt `lib/` |

## Install the plugin

Publish or pack the plugin, then:

```sh
dsh plugin --profile web add agent-colosseum
dsh plugin --profile desktop add agent-colosseum
dsh --profile web --dump-config   # look for "# == agent-colosseum"
```

The package declares `dsh.bundle` + `dsh.client` and ships compiled `lib/index.js` and `lib/client.js`. There is no install-time `prepare` script.

From this repo:

```sh
pnpm install
pnpm test
pnpm --filter agent-colosseum build
dsh plugin --profile web add ./packages/plugin
```

## Two first-run paths

1. **Local practice** — open the Colosseum control in the sidebar footer, pick two models (or the built-in script pair), start a match. No server, no grant.
2. **Friend room** — both machines install the plugin, register with an invite code, create/join a six-character room, confirm the same 10-call stake, play, then the winner sees `agent-colosseum` models in the selector.

## Stake (v1 only)

- 10 calls
- 16,000 estimated input tokens
- 65,536-byte serialized request hard cap
- 4,096 output tokens
- concurrency 1
- 604,800 seconds of *owner-online* TTL; the clock pauses while the owner is offline

Provider allowlist on the server is deny-by-default. DeepSeek and other paid routes stay off until a per-vendor review or written confirmation. Self-hosted OpenAI-compatible endpoints may be listed explicitly.

## Security

- API keys never leave the owner DSH process.
- Device signing and X25519 keys live in DSH credentials (`AGENT_COLOSSEUM_DEVICE_KEYS`).
- Relayed prompts are E2E encrypted. The Arena Server stores metadata only.
- The UI states that the model owner can theoretically inspect decrypted prompts.

## Deploy

A public Linux host, DNS, and TLS are required for real two-person play.

```sh
cp deploy/env.example deploy/.env
# set ARENA_DOMAIN, ARENA_INVITE_CODES, optional ARENA_PROVIDER_ALLOWLIST
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
deploy/scripts/health.sh https://$ARENA_DOMAIN
```

Backup / restore / rollback: `deploy/scripts/backup.sh`, `restore.sh`, `rollback.sh`.

PostgreSQL 17 is the authority for matches, stakes, grants, and deductions. Redis 7 is presence, rate limits, and short-lived clocks only.

## Compatibility

DSH is a developer preview. The plugin loads only on `0.1.0-rc.7` unless `ARENA_ALLOW_UNVERIFIED_DSH=1`. CI pins that version and runs a non-blocking canary note against master.

## Acceptance

Automated suites cover the engine, settlement/relay state machines, local scripted matches, and plugin RPC. After those pass, operators can mark `READY_FOR_TWO_PERSON_ACCEPTANCE`. The final two-human match (real TLS, two computers, one real grant stream, no API key in logs) is still performed by the operators.

## Out of scope (v1)

Cash, credits, grant transfer, shop, leaderboard, public matchmaking, spectating, other games, mobile native apps.
