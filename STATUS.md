# Delivery gates

Recaptured after the skeptic-gap fixes on `codex/production-completion`.
Node `v23.11.0`. Workspace scripts used `pnpm` 9.15.9 (`packageManager` remains `pnpm@11.7.0`).

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | **Met on this recapture.** `pnpm typecheck` exit 0. `pnpm lint` / `format:check` 0 warnings. `pnpm test:coverage` **119/119**, no `\|\| true`. Global coverage statements **97.23** / branches **90.15** / functions **96.46** / lines **97.23**. 100% branch on `auth.ts`, `frames.ts`, `poker-action.ts`, `engine.ts` (193/193), `settlement.ts`, `relay.ts`. Short-stack SB all-in now skips the jammed Button and runs out to showdown. Winner socket close aborts in-flight Owner streams (`relay.abort` + AbortSignal). Production `startArena` wires Redis 7 for presence, clocks, rate-limit, and pub/sub (not PING-only). `pnpm pack:plugin` tarball has `lib/index.js`, `lib/client.js`, `cordis.patch.yml`; runtime `dependencies` is empty; published scripts have no `prepare`. |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | **Local two-DSH + Compose TLS loop previously ran on this branch.** Caddy is `tls internal`, not public ACME. **Still blocked on public DNS/ACME TLS and two headed desktops with operator-approved vendor models.** Ship `release/agent-colosseum-0.1.0-alpha.1.tgz` plus `TWO_PERSON.md` to the operator panel for that run. |
| `ACCEPTED_FOR_CLOSED_ALPHA` | **Not met.** Requires two humans on two computers signing `TWO_PERSON.md`. |

Plugin tarball: `release/agent-colosseum-0.1.0-alpha.1.tgz`. Runtime `dependencies` are empty.

DSH install note: profiles are pnpm workspaces, so `dsh plugin --profile web add -w <tarball>` is required.

## Skeptic-gap fixes in this recapture

- HU 1-chip Button/SB vs 1/2 blinds: `PokerEngine.startHand` sets `toAct` to BB, BB may check, then run-out to a 5-card showdown. Fold-only on the jammed Button is no longer legal.
- Winner WS close looks up open inferences, sends `relay.abort` to the Owner, terminals the call (`aborted` if already deducted, `cancelled` if only reserved), and the Host `streamAsWinner` / `fulfillAsOwner` path subscribes to AbortSignal instead of polling after `waitType`.
- `startArena` constructs `RedisPresence`, `RedisClocks`, `RedisRateLimit`, and `RedisBus` on the live ioredis client. `/readyz` still PING/SELECT 1; those Redis structures now own heartbeat, 60s action deadlines, 90s grace, replay/rate-limit, and cross-instance frames.
