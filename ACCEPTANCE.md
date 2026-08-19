# Acceptance

## Automated gate → `READY_FOR_TWO_PERSON_ACCEPTANCE`

- [ ] `pnpm test` green (engine, settlement, relay, plugin runner)
- [ ] `pnpm --filter agent-colosseum build` produces `packages/plugin/lib/{index,client}.js`
- [ ] `dsh plugin --profile web add ./packages/plugin` and `dsh --profile web --dump-config` show the bundle
- [ ] Docker Compose brings up Postgres, Redis, Arena, Caddy; `/healthz` and `/readyz` succeed
- [ ] Two script policies complete a local match
- [ ] Duplicate `settleMatch` and duplicate `(grant_id, inference_id)` do not double-pay or double-charge

When the above hold, the tree is `READY_FOR_TWO_PERSON_ACCEPTANCE`.

## Human two-person run (not substitutable)

1. Issue two invite codes and a TLS endpoint.
2. Friend A and Friend B install the packed plugin on separate computers.
3. Each selects an allowlisted model, creates/joins a room, confirms the 10-call stake.
4. Play to a terminal result.
5. Winner must see the grant model under provider `agent-colosseum` and complete one real streamed call.
6. Loser’s local vendor must show the corresponding request. No API key in UI, logs, DB, or plaintext network.
7. Owner offline → grant unavailable, TTL paused; owner online → usable again.
