## Summary

<!-- What changes and why. Link the issue if there is one. -->

## Design notes

<!-- Decisions a reviewer should not have to reverse-engineer: alternatives
     considered, trade-offs accepted, anything deliberately left out. -->

## Verification

<!-- Commands run and their result. Paste real output; do not summarise a run
     that did not happen. -->

- [ ] `pnpm lint` / `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:integration` (if touched: database, queues, HTTP boundaries)
- [ ] `docker compose up` still healthy (if touched: infra, config, dependencies)

## Risk

<!-- What could break in production, and how it is detected or rolled back. -->
