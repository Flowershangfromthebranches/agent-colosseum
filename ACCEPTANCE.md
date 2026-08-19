# Acceptance

## Automated (this repo)

- [x] Poker engine tests: blinds 1/2→2/4→4/8→8/16, Button rotation, burns, conservation, sudden death, hidden opponent holes
- [x] Agent parser + `createUserMessage` followup
- [x] 50 concurrent settlements → one Grant; concurrent inference + concurrency 1; replay does not deduct; abort after start still deducts; AAD mismatch fails closed; Owner-offline TTL pause
- [x] `/readyz` fails if Postgres or Redis ping fails; live match restores from `PokerMatchStateV1`
- [x] typecheck, lint, format:check, coverage, build, pack
- [x] Tarball has no runtime `dependencies`; workspace packages are inlined in `lib/`
- [x] Real DSH 0.1.0-rc.7 Loader install into fresh web/desktop profiles (`add -w`); `--dump-config` includes `# == agent-colosseum`; Host boots
- [x] Docker Compose e2e (Postgres 17 + Redis 7 + production Arena image); `/readyz` is a real DB/Redis ping
- [x] Playwright against a live DSH page (Privacy → Lobby → nav)
- [ ] Public TLS (Caddy + operator domain/DNS) and two headed DSH processes completing Grant redeem with real vendor models

## Human two-person run

See `TWO_PERSON.md`. Not claimed.
