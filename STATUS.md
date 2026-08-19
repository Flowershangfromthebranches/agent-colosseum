# Delivery gates

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | Met in this repo. Live grant path, fail-closed protocol, A/B poker, extracted `auth.ts`, self-contained tarball. `typecheck`, `lint`, `format:check`, `test`, `test:coverage`, `build`, `pack:plugin` pass with no `\|\| true`. Coverage include is full `packages/*/src/**/*.ts`. Global statements/branches/functions/lines ≥90%; auth/protocol/poker/settlement/relay stay at 100% branch. |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | **Local Loader + Compose + two-process Grant stream ran here.** `dsh@0.1.0-rc.7` installs the packed tarball (`add -w`); Playwright opens Privacy/Lobby/nav. Colima Compose `/readyz` is a real DB/Redis ping. Two isolated plugin hosts (`apply()` + `handleArenaRpc`, script fold adapters) complete friend-room → 20-hand HU match → Grant issuance → winner streaming `agent-colosseum` through the live relay. Live fault cases: Arena restart restores the match; 89s single disconnect stays live and 90s forfeits; owner-offline TTL pauses; reserve replay does not deduct twice. **Still blocked on public TLS:** no operator domain/DNS, and two headed DSH desktops have not redeemed with vendor models. |
| `ACCEPTED_FOR_CLOSED_ALPHA` | **Not met.** Requires two humans on two computers signing `TWO_PERSON.md`. |

Plugin tarball: `release/agent-colosseum-0.1.0-alpha.1.tgz`. Runtime `dependencies` are empty.

DSH install note: profiles are pnpm workspaces, so `dsh plugin --profile web add -w <tarball>` is required.
