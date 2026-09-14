# Multivac OMP fork

Upstream baseline: `can1357/oh-my-pi@bdb9510b06824280cec9d05f3e5a45ce74289263` (18.1.18).
Browser baseline: `openchamber/openchamber@961f1611cb50cb7dd8d24c82e688ca6d8eef37bb`.

## Production status (2026-09-13)

The fork is live. The installed CLI and protected Windows service binary are
`omp/18.1.18`, SHA-256
`2738EA4C625ABAC7A1E73E7F0C64CA368C5283D5FC59D74FE390CAD34C6E260B`.
`Multivac OMP Runtime` serves the versioned RPC adapter on loopback port 4417;
`Multivac OMP Browser` serves the authenticated OpenChamber application on
4418 and hosted preview gate on 4419. Public access is
`https://omp.multivac.club/`, restricted by Google auth and the single-owner
allowlist. Wildcard previews use `*.omp-preview.multivac.club`.

The live browser has exercised pool management, a zero-cost native command and
restart/reconnect history, files, terminal, Git review, worktree controls,
goals, schedules, multi-run, GitHub PR status, and a real hosted preview. The
credential API returned safe summaries for two OpenCode Go accounts and no
secret fields. A production-only iframe routing bug and local-command reconnect
gap found during acceptance were fixed, regression-tested, rebuilt, and cut
over before this status was recorded.

The final cutover backup is
`C:\Users\neri\arrstack\appdata\secrets\omp-backups\2026-09-13-171745-cutover`.
The active executable rollback manifest is
`C:\Users\neri\AppData\Local\omp\omp-cutover-d1c024806e134d0da44373ce1d21bb77.json`.
Infrastructure and rollback procedure are authoritative in
`C:\Users\neri\arrstack\DOMAIN.md`.

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

## Browser adapter implementation notes

The private `/omp/agent-definition` endpoint supports GET, PUT and DELETE with
explicit `name` and `scope=user|project`; project scope uses the request directory.
PUT accepts native Markdown in `content`, validates it before replacing the file,
and applies to new workers. OpenChamber's native settings form is wired to this
endpoint.
GET with `inherit=true` can load a discovered definition when the selected scope
has no override. Responses distinguish inherited content from a stored override;
the agent catalog identifies the OMP runtime and native source scope for the UI.

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

- Browser message agent attribution is stored alongside native message identities;
  real RPC tests cover switching agents, branching history and backend restart.
  The adapter suite currently passes six tests with 83 assertions, including worker
  exit when the backend closes during startup and rejection of new worker requests.
- Browser commands now use RPC discovery, return local output as durable browser
  messages, retain request IDs for duplicate suppression, and accept the SDK's
  provider/model string and attachments. Five adapter tests pass with 61 assertions;
  the real RPC fixture verifies command expansion and attached text at the provider.
  Local command output is stored in the browser sidecar, outside model context.
- Native agent definitions include prompt, tools, spawn restrictions, model patterns,
  thinking, output schema, skills, read summarization, prewalk and advisor settings.
  Native startup now accepts `--agent-definition`; a real RPC test checks its prompt
  and restricted tool catalog. Browser requests now pass the selected definition and
  reopen idle workers while preserving history; busy-session switches are rejected.
  The execution alias now shares task-agent resolution; real workers verify both
  enabled and disabled eval backends. Optional-setting and browser UI parity checks
  remain before counting this workflow as fully ported.
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
- Browser adapter is complete and deployed; later checkpoints below preserve
  implementation and validation history.

## Completed cutover checklist

- Native agent, command, MCP, and OAuth configuration mappings are implemented.
- Retained browser workflows were exercised against OMP in focused tests and live acceptance.
- Session ownership protects browser workers, idle CLI history, and running legacy processes.
- Owner authentication covers HTTP, streaming, preview, terminal, and WebSocket routes.
- Compiled-binary, state migration, backup, install, supervision, DNS, TLS, ingress,
  and rollback checks passed.

The isolated development launcher is `arrstack/scripts/start-omp-development.ps1`.
It uses a protected copy of state and private ports 4407/4408. Production uses the
scheduled tasks and protected state described above.

## Native MCP configuration checkpoint

Native MCP configuration now has a private `/omp/mcp-config` endpoint with explicit
`user` or `project` scope. GET returns only transport, enabled/timeout/request-ID
settings and configured field names. Connection fields (including URLs, arguments,
environment, headers and OAuth values) are write-only. POST creates; PATCH preserves
omitted fields and nested map members, with null removing a field; DELETE removes
the scoped entry. Changes use the existing per-file lock and atomic writer, and apply
to new workers. The existing session endpoint controls live connections separately.

The focused configuration and private-API tests pass (2 tests, 64 assertions), as do
the type check and scoped lint. Browser settings, discovered-source overrides, and
OAuth were completed in later checkpoints and are live in production.

Idle-session MCP reload is implemented through `reload_mcp` and POST
`/session/:id/mcp` with `{"reload":true}`. CLI and RPC share discovery filters,
cache invalidation, and tool refresh, including cleanup after failed discovery.
Active streaming, compaction, shell and eval operations reject reload. The response
reports only a failure count and safe connection state. Tests cover external edits,
failed discovery cleanup, busy-session rejection and real RPC removal/restoration
of tools. The staged HTTP endpoint successfully reloaded its fixture with zero
failures. The browser reload button was exercised against a disabled fixture (1/1
to 0/0), then its restored configuration (0/0 to 1/1). The fixture was restored.
The web build, UI and OMP type checks, scoped lint, shared reload tests and real RPC
reload test passed. This does not validate OAuth or production access.

## Browser MCP OAuth checkpoint

Browser MCP OAuth has a server-owned state coordinator using the existing native
PKCE flow and URL/profile-keyed credential store. Its local-provider test covers
invalid state, concurrent callbacks, replay, credential persistence, provider-error
redaction, preservation of existing credentials on failure, cancellation and expiry
(2 tests, 39 assertions including the private HTTP API). Private start/status/cancel
and callback routes now use native configuration and endpoint discovery. Callback
origins come from OMP_WEB_BROWSER_ORIGIN, restricted to HTTPS or HTTP loopback;
requests cannot override them. Tests cover private authentication, Origin rejection,
unknown callbacks, successful discovery/exchange, fixed redirects and replay.
Responses suppress caching and referrers. Reauthorization updates the existing resolved
credential reference; the test verifies the legacy row changes without an unused new row.
Scoped GET recovers the latest attempt without starting or exchanging another grant.
Browser controls and challenge-based discovery parity were completed and browser-tested.
The staging launcher still supplies the loopback browser origin for isolated development.

## Installation backup

On 2026-09-12 an initial backend smoke run opened the live database and added the
two empty pool tables before the intended backup step. No credentials were changed.
That process was stopped. A consistent SQLite backup and original executable/config
are now under the ACL-restricted arrstack `appdata/secrets/omp-backups/2026-09-12`.
The backup includes those empty additive tables. Existing OMP processes were not stopped.
