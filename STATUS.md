# Delivery gates

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | Met in this repo. Live grant path, fail-closed protocol, A/B poker, extracted `auth.ts`, self-contained tarball. `typecheck`, `lint`, `format:check`, `test`, `test:coverage`, `build`, `pack:plugin` pass with no `\|\| true`. Coverage include is full `packages/*/src/**/*.ts`. Global statements/branches/functions/lines ≥90%; auth/protocol/poker/settlement/relay stay at 100% branch. |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | **Local two-DSH + Compose TLS loop ran here.** Packed `release/agent-colosseum-0.1.0-alpha.1.tgz` installs into two fresh `dsh@0.1.0-rc.7` web homes (`add -w`); `--dump-config` contains `# == agent-colosseum` for host, guest, and desktop. Compose e2e now includes Caddy 2: `https://localhost:8443/readyz` and `wss://localhost:8443/v1/ws` work with Caddy `tls internal` (not public ACME). Playwright against two live DSH pages (`:3191` / `:3192`) drives friend-room → match → Grant inventory using the allowlisted self-hosted `openai-compatible` fold models. Earlier `apply()` two-process relay stream and restart/89s/90s/TTL/idempotency cases remain green. **Still blocked on public DNS/ACME TLS and two headed desktops with operator-approved vendor models.** |
| `ACCEPTED_FOR_CLOSED_ALPHA` | **Not met.** Requires two humans on two computers signing `TWO_PERSON.md`. |

Plugin tarball: `release/agent-colosseum-0.1.0-alpha.1.tgz`. Runtime `dependencies` are empty.

DSH install note: profiles are pnpm workspaces, so `dsh plugin --profile web add -w <tarball>` is required.
