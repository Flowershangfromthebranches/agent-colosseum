# Delivery gates

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | Automated product path is in place: live Grant relay (`streamGrantThroughOwner`), real `/readyz` pings, fail-closed frames, A/B poker with `PokerMatchStateV1`, extracted `auth.ts`, self-contained plugin tarball. `typecheck`, `lint`, `format:check`, `test`, `test:coverage`, `build`, and `pack:plugin` pass with no `\|\| true`. Full-repo coverage include is `packages/*/src/**/*.ts` (tests and `*.d.ts` only). Latest measured totals: statements/lines 98.46%, functions 98.03%, branches 91.01%. Per-file 100% branch: protocol validators (`frames.ts`, `poker-action.ts`, and the rest of `protocol/src`), `packages/poker/src/engine.ts`, `packages/server/src/auth.ts`, `packages/server/src/settlement.ts`, `packages/server/src/relay.ts`. |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | **Not met here.** This environment does not have `dsh` or `docker`. Official Loader install, production image/Compose, TLS, and two real DSH processes were not executed. |
| `ACCEPTED_FOR_CLOSED_ALPHA` | **Not met.** Requires two humans on two computers signing `TWO_PERSON.md`. |

These three gates are independent. Automated coverage and pack do not claim two-person acceptance. Two-person acceptance cannot replace the automated gates.

Plugin tarball: `agent-colosseum-0.1.0-alpha.1.tgz` (also copied under `release/`). Runtime `dependencies` remain empty; Host+Client bundles are prebuilt in `lib/`.
