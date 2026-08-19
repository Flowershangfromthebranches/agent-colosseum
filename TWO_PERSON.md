# Two-person closed Alpha (gate 3)

This environment cannot operate two personal computers. Complete these steps
on two machines after `READY_FOR_TWO_PERSON_ACCEPTANCE` (DSH Loader + Compose
on a public WSS host). Do **not** treat this document as acceptance.

## Package

`release/agent-colosseum-0.1.0-alpha.1.tgz` (or `pnpm pack:plugin`).

## On each computer (DSH 0.1.0-rc.7)

```sh
# DSH profiles are pnpm workspaces; -w is required so the tarball is added
# to the profile root (without it, pnpm 11 refuses ADDING_TO_ROOT).
dsh plugin --profile web add -w ./agent-colosseum-0.1.0-alpha.1.tgz
dsh plugin --profile desktop add -w ./agent-colosseum-0.1.0-alpha.1.tgz
dsh --profile web --dump-config   # must include "# == agent-colosseum"
```

1. Open Colosseum from the sidebar, accept the privacy disclosure
   (the model owner can inspect decrypted relay prompts).
2. Friend A: create a room with an allowlisted model (default: self-hosted
   `openai-compatible`, not DeepSeek unless allowlisted).
3. Friend B: join the six-character code with a **different** model.
4. Both confirm the 10-call / 16k / 64KiB / 4k / concurrency-1 / 7-day stake.
5. Play to a terminal result. Winner must see `agent-colosseum` in the model
   selector and complete one streamed call. Loser’s vendor must show that call.
6. Confirm API keys and plaintext prompts are absent from UI, DSH logs, Arena
   logs, and Postgres. Owner offline → grant unavailable, TTL paused; online
   again → usable. Uninstall and rollback as needed.

Sign this file only after those observations. That signature is
`ACCEPTED_FOR_CLOSED_ALPHA`.
