# Delivery gates

Recaptured after rebuilding Compose Arena onto the Redis-wired image
(`deploy-arena` `4033030d720a`, binary contains `RedisClocks` /
`arena:clocks:action` / `arena:presence`).

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | **Held.** Prior recapture on `b87357c` plus this Host remint-on-`UNAUTHORIZED` (no persisted `deviceId`) so a returning keypair cannot stay stuck on `connecting`. Plugin typecheck 0; connection unit tests 3/3. |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | **Local two-DSH + rebuilt Compose loop ran here.** `/readyz` `{ok,db,redis}` through Caddy `https://localhost:8443`. Two-process DSH vs live Arena: friend-room → Grant redeem, exit 0 (463ms). Playwright overlay + two real DSH pages 3191/3192: Lobby → Create/Join/Accept → Hand/Result → Grant inventory → Stream grant, **2 passed**. Live fault cases on the new image: restart restore + 89s/90s forfeit (105s), owner-offline TTL pause + reserve replay (2s). Image after fault restart still contains `RedisClocks`. Caddy is `tls internal`, **not public ACME**. **Still blocked on public DNS/ACME and two headed desktops with operator-approved vendor models.** |
| `ACCEPTED_FOR_CLOSED_ALPHA` | **Not met.** Requires two humans on two computers signing `TWO_PERSON.md`. |

Plugin tarball: `release/agent-colosseum-0.1.0-alpha.1.tgz`.

DSH install: `dsh plugin --profile web add -w <tarball>`. E2E profiles pin `wss://localhost:8443/v1/ws` and invites `E2EHOSTINVITE01` / `E2EGUESTINVITE02`.

## Evidence (this recapture)

- `two-process-dsh.txt`: `TWO_PROCESS_EXIT=0`
- `playwright-two-dsh-retry2.txt`: `2 passed`, `PLAYWRIGHT_EXIT=0`
- `live-arena-fault.txt`: `FAULT_EXIT=0`, `readyz_after` ok, `RedisClocks` present
- `dump-config-web-host.txt` / `dump-config-web-guest.txt`: `# == agent-colosseum`
