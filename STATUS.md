# Delivery gates

Recaptured on `codex/production-completion` after `e77e8ea`, then one
follow-up test-only commit. Node `v23.11.0`. Workspace scripts used
`pnpm` 9.15.9 (`packageManager` field remains `pnpm@11.7.0`).

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | **Met on this recapture.** `pnpm typecheck` exit 0. `pnpm lint` / `format:check` 0 warnings. `pnpm test:coverage` **110/110**, no `\|\| true`. Global coverage statements **96.97** / branches **90.24** / functions **96.72** / lines **96.97**. 100% branch on `auth.ts`, `frames.ts`, `poker-action.ts`, `engine.ts` (194/194), `settlement.ts`, `relay.ts`. `pnpm pack:plugin` tarball has `lib/index.js`, `lib/client.js`, `cordis.patch.yml`; runtime `dependencies` is empty; published scripts have no `prepare`. Concurrent deduct: 50 `relay.start` in parallel → 1 fulfilled, 49 rejected, `callsRemaining` 9 (`CONCURRENT_EXIT=0`). |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | **Local two-DSH + Compose TLS loop previously ran on this branch.** This recapture re-checked `dsh --profile web --dump-config` and `dsh --profile desktop --dump-config`: all contain `# == agent-colosseum` (host invite `E2EHOSTINVITE01`, guest `E2EGUESTINVITE02`, `wss://localhost:8443/v1/ws`). Caddy is `tls internal`, not public ACME. Playwright two-page run and live Compose fault cases (restart restore, 89s/90s forfeit, owner-offline TTL pause, reserve replay) were captured earlier on this branch and are not re-claimed as a new two-desktop public-TLS run. **Still blocked on public DNS/ACME TLS and two headed desktops with operator-approved vendor models.** |
| `ACCEPTED_FOR_CLOSED_ALPHA` | **Not met.** Requires two humans on two computers signing `TWO_PERSON.md`. |

Plugin tarball: `release/agent-colosseum-0.1.0-alpha.1.tgz`. Runtime `dependencies` are empty.

DSH install note: profiles are pnpm workspaces, so `dsh plugin --profile web add -w <tarball>` is required.

This recapture also stopped `pnpm` from auto-installing latest `@deepseek-ai/*` peers (`auto-install-peers=false`). An installed Harness newer than the pin (`0.1.0-rc.7`) is still fail-closed unless `allowUnverifiedDsh` is set; the compat unit test no longer assumes an unverified `DSH_VERSION` overrides a resolved package.
