# Delivery gates

| Gate | Status |
| --- | --- |
| `IMPLEMENTATION_COMPLETE` | Code paths for local match, friend-room protocol, settlement, relay FSM, plugin RPC/UI, pack and compose exist. Remaining: live DSH Loader install, production image smoke, and 90% coverage on every listed file. |
| `READY_FOR_TWO_PERSON_ACCEPTANCE` | Blocked on operator Linux host, TLS domain, and CI Compose/DSH Loader jobs against a real checkout. |
| `ACCEPTED_FOR_CLOSED_ALPHA` | Requires the two-human match on separate computers. |

Automation cannot mark the third gate. See `ACCEPTANCE.md`.
