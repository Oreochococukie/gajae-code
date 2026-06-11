# Grok Build provider design

## Status

Proposal for maintainer design review. This document intentionally does not add a bundled provider implementation. It defines the provider contract and the staged PR split for adding a Grok Build integration after the contract is accepted.

## Problem

GJC can load third-party extensions, but the first-run interactive path currently needs a maintainer-owned decision before a bundled Grok Build provider can be accepted. The desired product flow is:

```text
gjc -> /login -> OAuth -> Grok Build -> browser xAI login -> /model -> grok-cli/grok-composer-2.5-fast
```

The previously proposed implementation touched bundled extension loading, OAuth registration, model profiles, vendor code, usage reporting, and tests in one PR. That is too much surface for review without first agreeing on the provider contract.

## Goals

- Keep Grok Build as a bundled provider extension, not a workflow skill.
- Preserve the existing four bundled workflow skills and four role agents.
- Make `/login` show an OAuth provider named `Grok Build` with provider id `grok-cli`.
- Make `/model` expose `grok-cli/grok-composer-2.5-fast` after the bundled provider is loaded.
- Let first-run sessions load maintainer-approved bundled providers even when regular extension discovery is disabled.
- Keep credentials in the existing auth storage path; no tokens or user env values are checked into the repo.
- Keep implementation PRs small enough for independent review and rollback.

## Non-goals

- No new workflow command or `/skill` surface.
- No automatic installation from npm or remote code at runtime.
- No `models.json` direct edits.
- No broad model-profile reshuffle beyond a reviewed Grok-specific profile.
- No provider-specific secrets in source. The xAI OAuth client id is a public client id, not a secret.

## Proposed provider contract

| Field | Proposed value | Notes |
| --- | --- | --- |
| Provider id | `grok-cli` | Stable selector prefix and auth key. |
| Display name | `Grok Build` | Name shown in `/login` and UI surfaces. |
| Default user-facing model | `grok-composer-2.5-fast` | Full selector: `grok-cli/grok-composer-2.5-fast`. |
| Secondary model | `grok-build` | Used by a future `grok-pro` role profile if accepted. |
| Base URL | `https://cli-chat-proxy.grok.com/v1` | Overridable by explicit env/config for debugging only. |
| OAuth issuer | `https://auth.x.ai` | OIDC discovery must validate xAI-owned HTTPS endpoints. |
| OAuth callback | loopback `127.0.0.1` | Uses PKCE + state validation. |
| API adapter | `grok-cli-responses` | Provider-specific stream adapter; not a new generic API shape. |
| Env bypass | `GROK_CLI_OAUTH_TOKEN` | Optional local bypass; no refresh or discovery guarantees. |

## OAuth behavior

The OAuth implementation should use the existing custom OAuth provider path:

1. `grok-cli` registers an OAuth provider named `Grok Build`.
2. `/login` calls the existing auth storage login path for that provider.
3. The provider opens an xAI authorization URL using OIDC discovery, PKCE, `state`, and a loopback callback.
4. The callback exchanges the authorization code for access and refresh tokens.
5. Credentials are stored by the existing auth storage code path.
6. Refresh uses the stored refresh token and validates the token endpoint origin.

Security constraints:

- OIDC `authorization_endpoint` and `token_endpoint` must be HTTPS and under xAI-owned hosts.
- The callback server binds to loopback by default.
- The callback must reject state mismatches.
- Access and refresh tokens must not be logged, rendered, or committed.
- Error messages should include status and provider error text, but not credential values.

## Bundled loading behavior

A bundled provider is different from user extension discovery:

- It is committed under source-controlled bundled defaults.
- It is loaded by maintainer-owned bootstrap code before model selection.
- It is still represented as an extension/provider internally so the same provider registration APIs are exercised.
- It must load even when `disableExtensionDiscovery: true` is used for first-run interactive sessions.
- It must coexist with caller-supplied `additionalExtensionPaths`.

The bootstrap change should be its own PR because it is useful independently of Grok Build and is the highest-risk core-path change.

## Model/profile behavior

Model registration should be provider-owned. The Grok provider should register at least:

- `grok-composer-2.5-fast`
- `grok-build`

A built-in profile is optional and should be reviewed separately. If accepted, the proposed profile is:

```text
grok-pro.default  -> grok-cli/grok-composer-2.5-fast
grok-pro.planner  -> grok-cli/grok-composer-2.5-fast
grok-pro.critic   -> grok-cli/grok-composer-2.5-fast
grok-pro.executor -> grok-cli/grok-build
grok-pro.architect -> grok-cli/grok-build
```

If maintainers prefer not to add a built-in profile, the provider can still satisfy the core `/login` and `/model` flow through direct model selection.

## Usage reporting behavior

Usage reporting should be an optional follow-up after login/model support lands:

- Provider id: `grok-cli`.
- Fetches usage with the effective OAuth access token.
- Returns `null` when no token is available.
- Does not require the usage provider for chat/model selection to work.

## Staged PR plan

### PR 1: this design document

Purpose: agree on the provider id, OAuth contract, bundled-loading contract, model selector, security boundaries, and implementation split.

### PR 2: bundled provider bootstrap contract

Small core change only:

- Add a maintainer-owned way to enumerate bundled provider extension paths.
- Load those paths during session/bootstrap even when user extension discovery is disabled.
- Add tests proving bundled providers and caller-supplied extension paths coexist.

No Grok vendor implementation in this PR.

### PR 3: Grok Build provider extension

Provider implementation only:

- Add bundled `grok-build` and `grok-cli` provider source.
- Register `grok-cli` OAuth and models.
- Include sanitize and provider-specific stream handling.
- Test `/login` provider registration and `grok-composer-2.5-fast` model availability.

### PR 4: profile and model defaults

Optional product-surface PR:

- Add `grok-pro` only if maintainers accept a built-in profile.
- Add model profile catalog tests.

### PR 5: usage reporting

Optional observability PR:

- Add `grok-cli` usage provider.
- Add focused usage tests.

## Acceptance criteria for the implementation series

- Fresh checkout test proves `createAgentSession` registers the bundled provider with `disableExtensionDiscovery: true`.
- `/login` includes `Grok Build` for provider id `grok-cli`.
- `/model` includes `grok-cli/grok-composer-2.5-fast`.
- A real OAuth URL redirects to the xAI account login page.
- Third-party extension paths still load alongside bundled providers.
- Token values never appear in tests, logs, checked-in docs, or git history.

## Open maintainer decisions

- Should `grok-cli` be the final provider id, or should the project prefer `grok-build` as the public selector prefix?
- Should the bundled bootstrap contract be provider-specific at first or generic for future bundled providers?
- Should `grok-pro` be a built-in profile or documented as a user profile?
- Should usage reporting be included in the initial provider PR or kept as a separate follow-up?
