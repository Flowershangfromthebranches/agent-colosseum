# Delivery gates

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | Product grant stream is `streamGrantThroughOwner` (reserve → preflight → started → AAD chunks → terminal). Host bundle contains no `RELAY_UNBOUND`. Contest followups use `createUserMessage()`. typecheck, lint, format:check, tests, coverage (measured product surface ≥90% statements/lines), build, and pack pass without `\|\| true`. |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | **Not met here.** `dsh` and `docker` are not installed in this environment (see captured launcher failure). Compose, TLS, and two-process Loader E2E have not been executed. |
| `ACCEPTED_FOR_CLOSED_ALPHA` | **Not met.** Requires two humans on two computers. Steps: `TWO_PERSON.md`. |

Coverage is gated on poker, protocol, settlement, relay, grant-relay, auth/store/presence, and the Host adapter/parser — not on WebSocket-only connection glue. Branch coverage on that surface is ~82% globally; poker/protocol statements are ≥96%.
