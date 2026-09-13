# Multivac OMP fork

Upstream baseline: `can1357/oh-my-pi@bdb9510b06824280cec9d05f3e5a45ce74289263` (18.1.18).
Browser baseline: `openchamber/openchamber@961f1611cb50cb7dd8d24c82e688ca6d8eef37bb`.

## Credential pool

OpenCode Go uses the shared AuthStorage selector for both CLI and browser requests.
The default is most headroom across rolling and weekly usage. Sticky and round-robin
are alternatives. Pool settings and per-account controls live in additive SQLite
tables alongside existing credentials; keys remain in the upstream credential table.
Selection uses a short immediate transaction after quota polling, so independent
processes share the ordering. A single-key pool follows the same eligibility rules.

Monthly paid fallback defaults off. Enabling it does not bypass rolling/weekly
hard limits. Disable OpenCode's own Use balance setting for subscription-only
accounts: cached usage cannot prevent an in-flight request crossing a limit.
Explicit CLI/config key overrides retain upstream precedence and bypass pooling.

## Browser adapter (work in progress)

`bun scripts/openchamber-server.ts` starts the loopback-only authenticated backend.
It requires OPENCODE_SERVER_PASSWORD with at least 32 characters. OMP_WEB_PORT
defaults to 4097; OMP_EXECUTABLE selects a compiled CLI, otherwise the source CLI
runs under the same Bun executable. OMP_WEB_DATA_DIR and OMP_WEB_AUTH_DB allow
isolated development state. Never point test instances at the live profile.

OpenChamber connects through its existing external-server connection. Unsupported
routes return 501 while the port is in progress, rather than reporting empty success.
Do not deploy or replace the installed CLI until browser parity, auth, session
ownership, and compiled-binary tests pass.

## Current verification

- Pool policy suite: 14 passing tests, including bounded failover and persistent cooldowns.
- Go login fixture now includes quota data; login and pool regression group passed.
- Browser adapter: 5 passing tests covering private authentication, real RPC session
  ownership, streaming, reconnect without prompt replay, persisted message IDs,
  questions, denied tool approval, cancellation, nested subagents, and utility calls.
- The combined pool/login/browser/RPC group passes 38 tests with 138 assertions.
- AI package lint, format and type checks pass; coding-agent type checks and changed-file
  lint/format pass. These are focused checks, not a full upstream release validation.
- OpenChamber utility tests pass (30 tests). Its dead-code scan reports no added pool
  or utility exports; unrelated upstream findings remain. Existing anti-slop lint
  findings remain in the upstream utility modules.
- Browser UI type check and web build passed. The isolated dashboard reads a protected
  backup of the Go account: weekly capacity is exhausted and paid fallback remains off.
- Browser pool save was exercised successfully after adding Origin validation to the
  private proxy. Cross-origin writes return 403; 14 proxy tests pass.
- RPC lifecycle suite passes, including worker exit and late-prompt failure checks.
  Windows pipe assertions explicitly await I/O before invoking Bun's assertion matcher.
- Browser adapter is not yet complete or deployed.

## Remaining before cutover

- Port agent selection/configuration, commands, MCP and OAuth configuration to native
  OMP behavior. Several existing browser settings still target OpenCode files.
- Exercise goals, schedules, multi-run/fusion, worktrees, Git review, terminal, previews,
  and GitHub workflows against OMP. Existing controls do not count as validated parity.
- Finish subagent batch navigation and session ownership auditing, including protection
  for running legacy CLI processes that predate the new writer lease.
- Add and test owner authentication on the browser backend and every HTTP/WebSocket
  path before configuring Caddy, DNS, DDNS, or public access.
- Build/smoke-test the Windows executable, prevent upstream update replacement,
  validate migration/rollback, then perform the reversible installation and hosting cutover.

The isolated development launcher is `arrstack/scripts/start-omp-development.ps1`.
It uses a protected copy of state and private ports 4407/4408. The currently installed
executable and public domain are unchanged. No production service is registered yet.

## Installation backup

On 2026-09-12 an initial backend smoke run opened the live database and added the
two empty pool tables before the intended backup step. No credentials were changed.
That process was stopped. A consistent SQLite backup and original executable/config
are now under the ACL-restricted arrstack `appdata/secrets/omp-backups/2026-09-12`.
The backup includes those empty additive tables. Existing OMP processes were not stopped.
