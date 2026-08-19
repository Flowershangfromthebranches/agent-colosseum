# Delivery gates

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | Met in this repo. Live grant path, fail-closed protocol, A/B poker, extracted `auth.ts`, self-contained tarball. `typecheck`, `lint`, `format:check`, `test` (104), `test:coverage`, `build`, `pack:plugin` pass with no `\|\| true`. Coverage include is full `packages/*/src/**/*.ts`. |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | **Local Loader + Compose loop ran here.** `dsh@0.1.0-rc.7` installs the packed tarball (`add -w`) into fresh web and desktop profiles; `--dump-config` contains `# == agent-colosseum`; `dsh --profile web` serves `http://127.0.0.1:3191` and Playwright opens Privacy/Lobby/nav on the live Client. Colima + `deploy/docker-compose.e2e.yml` builds the production Arena image; `/readyz` returns `{ok,db,redis}` after real Postgres/Redis pings; two authenticated WebSockets create/join/accept and receive `match.proposal`. **Not yet a public TLS two-DSH Grant stream:** no operator domain/DNS, and two headed DSH processes were not driven through a complete Grant redeem with real vendor models. |
| `ACCEPTED_FOR_CLOSED_ALPHA` | **Not met.** Requires two humans on two computers signing `TWO_PERSON.md`. |

Plugin tarball: `release/agent-colosseum-0.1.0-alpha.1.tgz`. Runtime `dependencies` are empty.

DSH install note: profiles are pnpm workspaces, so `dsh plugin --profile web add -w <tarball>` is required.
