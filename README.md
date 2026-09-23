# n8n-nodes-comers

Receive [Comers](https://github.com/rocketdeploy-dev) domain events in
[n8n](https://n8n.io). Publishing a workflow subscribes it in Comers;
unpublishing it archives the subscription.

This package contains one trigger node and one credential:

| | |
| --- | --- |
| **Comers Trigger** | Creates the workflow's own Comers event subscription when the workflow is published, verifies every delivery against Comers' public keys before the workflow runs, and archives the subscription when the workflow is unpublished or deleted. |
| **Comers API** | A Comers machine integration: the Comers URL, a client ID and a client secret. |

There is nothing to copy between Comers and n8n by hand: no webhook URL to
paste into Comers and no signing secret to paste into n8n.

## Installation

In n8n, go to **Settings → Community nodes → Install** and enter
`@comers/n8n-nodes-comers`.

## Setting up

### 1. Create a machine integration in Comers

In Comers, create an API integration for this n8n and grant it the scope
**`comers.core.events.subscriptions.manage-own`**. Comers shows the client ID
and the client secret; the secret is shown once.

### 2. Add the credential

In n8n, create a **Comers API** credential:

| Field | Value |
| --- | --- |
| **Comers URL** | The public HTTPS origin of your Comers installation, without a path |
| **Client ID** | The integration's client ID |
| **Client Secret** | The integration's client secret |

The credential test asks Comers for a token with exactly the scope above, so it
tells you apart a wrong client ID or secret (*Comers did not accept this client
ID and secret*) and a missing scope (*… needs the scope
comers.core.events.subscriptions.manage-own*).

### 3. Add the trigger and choose events

Add **Comers Trigger**, pick the credential and list the events:

- **Event Key** — any key from the Comers event catalog, for example
  `comers.core.support.case.opened`. There is no fixed list in the node: an
  event Comers adds later works without a new release of this package.
- **Event Version** — the payload version, 1 unless the catalog says otherwise.

**Subscription Name** is optional; by default it is the workflow and node
names. The node always appends a short identifier, `[n8n <id>]`, which it uses
to find its own subscription again.

### 4. Publish the workflow

Publishing creates the subscription in Comers for the workflow's **production**
webhook URL. Unpublishing or deleting the workflow archives it; publishing
again creates a new one. Changing the events or the name and publishing again
updates the existing subscription.

"Listen for test event" in the editor creates a temporary Comers subscription
for n8n's `webhook-test` URL. It is separate from the production subscription,
uses the same `jws-es256-v1` verification, and is archived when listening ends.
Publishing creates a separate production subscription for the `webhook` URL.
delivers to published workflows, and those deliveries appear in the executions
list.

n8n registers the webhook just after the workflow is published. If Comers
cannot be reached or refuses (for example because the integration lacks the
scope), n8n shows the error on the workflow and the subscription is not
created; fix the cause and publish again.

## What the node stores

The node keeps, in the workflow's static data, only what it needs to find and
verify its subscription — none of it is secret:

| Key | |
| --- | --- |
| `schemaVersion` | The layout of this state |
| `registrationId` | A stable identifier of this workflow and node, also in the subscription name |
| `subscriptionId` | The subscription Comers created |
| `jwksUri` | Where Comers publishes the keys that verify its deliveries |
| `signatureProfile` | Always `jws-es256-v1` |
| `organizationId` | The integration's organization, which every delivery must be signed for |

n8n stores static data unencrypted and includes it in workflow exports, which
is exactly why nothing secret goes there. The client secret stays in the
encrypted credential and is only ever sent to the Comers token endpoint. The
access token lives in memory until shortly before it expires; after a restart
the node simply asks for a new one. Comers' public keys are cached in memory
for as long as Comers says they may be.

## The lifecycle, exactly

**Publish** — n8n asks the node whether its subscription exists:

- with a recorded `subscriptionId`, the node reads it. Found and pointing at
  this workflow's URL: it exists (its name and events are brought up to date).
  Archived, or pointing at another URL: it is retired and a new one is created.
  Not found (404): the stale ID is forgotten.
- with no usable ID, the node looks through the integration's own
  subscriptions for exactly one that is not archived, uses this workflow's URL
  and carries this node's identifier. That recovers a subscription whose
  creation succeeded in Comers but whose answer never reached n8n, instead of
  creating a second one. Two matches are an error, never a guess, and a
  subscription that merely looks similar is never adopted.
- any other answer from Comers is an error. It is never read as "does not
  exist", because that would create a duplicate.

When nothing exists, the node creates a `jws-es256-v1` subscription and records
it.

**Unpublish or delete** — the node archives exactly the recorded subscription.
The state is cleared only when Comers confirms (204) or no longer knows it
(404); on any other answer it is kept, so n8n can retry the cleanup.

## What the workflow receives

A verified delivery produces exactly one item, with two keys, all of it covered
by the signature:

- **`event`** — the Comers event envelope, exactly as signed. Nothing is
  renamed, removed, added or overwritten, and fields Comers adds later come
  through untouched.
- **`delivery`** — the delivery it came in.

```json
{
  "event": {
    "specVersion": "comers.v1",
    "eventId": "0199c3f0-1a2b-7c3d-8e4f-000000000001",
    "eventKey": "comers.core.support.case.opened",
    "eventVersion": 1,
    "sequence": "9007199254740993",
    "occurredAt": "2026-09-22T07:05:30.000Z",
    "producer": "comers-core-support",
    "scope": {
      "organizationId": "0199c3f0-1a2b-7c3d-8e4f-00000000000a",
      "sellerId": null,
      "sellerStoreId": null
    },
    "subject": { "type": "support_case", "id": "0199c3f0-1a2b-7c3d-8e4f-00000000000b" },
    "correlationId": null,
    "data": { "priority": "high" }
  },
  "delivery": {
    "subscriptionId": "0199c3f0-1a2b-7c3d-8e4f-000000000002",
    "deliveryId": "0199c3f0-1a2b-7c3d-8e4f-000000000003",
    "deliveryAttempt": 1,
    "timestamp": 1788259530
  }
}
```

`sequence` is a decimal string because it is a 64-bit counter. The JWS itself,
the token and the credential never appear in the output or in the logs.

### Write idempotent workflows

Delivery is **at-least-once**: the same `event.eventId` can arrive more than
once — after a timeout, a retry or a replay from Comers. `deliveryAttempt`
counts from 1 within a run and starts at 1 again after a replay, so it is not an
identifier. Deduplicate on **`event.eventId`**. The node keeps no record of what
it has seen.

## How a delivery is verified

Comers sends every delivery as an RFC 7515 JWS in flattened JSON serialization
(`Content-Type: application/json`):
`{"protected": …, "payload": …, "signature": …}`, signed with ES256 by a key
that belongs to your Comers installation — not to this workflow, and never
shared with anyone. Before the workflow runs, the node:

1. requires exactly `protected`, `payload` and `signature` — no unprotected
   header;
2. requires the protected header to be exactly `alg: ES256`,
   `typ: comers-delivery+jws` and a `kid` of the form `v<version>.<thumbprint>`.
   `none`, HMAC and every other algorithm are refused before a key is chosen;
3. finds the `kid` among the keys Comers publishes at
   `<Comers URL>/core/api/v1/event-delivery-keys` — only that origin and that
   path, as recorded at registration. Every key must be a well-formed public
   P-256 key whose `kid` is its own RFC 7638 thumbprint. The key set is cached
   for its `Cache-Control: max-age`. An unknown `kid` triggers one refresh (at
   most one every 10 seconds), then the delivery is refused;
4. verifies the signature over the exact bytes received;
5. only then decodes the payload, and requires it to be signed for **this**
   subscription and this organization, with a timestamp within **300 seconds**
   of the n8n clock, and a valid Comers envelope.

Keep the n8n clock synchronised (NTP): the timestamp check is what stops a
captured delivery being replayed later.

### Response codes, and what Comers does with them

| Status | Body | Meaning | Comers |
| --- | --- | --- | --- |
| `200` | — | Verified; the workflow runs | delivered |
| `400` | `not_flattened_jws`, `malformed_envelope` | Not a Comers delivery | dead letter, no retry |
| `401` | `algorithm`, `protected_header`, `unknown_kid`, `signature`, `payload`, `payload_shape`, `malformed_delivery`, `other_subscription`, `other_organization`, `stale_timestamp`, `unsupported_spec_version`, `not_registered` | Refused | dead letter, no retry |
| `503` | `keys_unavailable` | The public keys could not be fetched | retried |
| `500` | `internal_error` | Unexpected failure | retried |

A `200` means n8n accepted the event, not that the workflow succeeded.

## Credentials

**Comers API** holds the Comers URL, the client ID and the client secret (as a
password field). n8n applies the client secret only to the token request, as
HTTP Basic client authentication (`client_secret_basic`); every other call
carries a short-lived access token. When Comers rejects a cached token, the
node fetches a new one once and repeats the call once.

Rotating the client secret in Comers means updating the credential; the
subscription and its deliveries are unaffected, because no delivery secret
exists.

## Compatibility

**Verified with n8n 2.40.5** — the built package loaded as a custom extension
and exercised against a contract stub of the Comers API: the credential test,
publishing (subscription created for the production URL), a signed delivery
running the workflow, and unpublishing (subscription archived).

Requires a Comers installation with machine access and `jws-es256-v1` delivery
(machine-credentials M7A). The package has no runtime dependencies. It reads no
environment variables and touches no files.

## Development

```sh
npm install
npm run dev          # n8n with this node loaded, on http://localhost:5678
npm test             # the verifier, the envelope reader and the node
npm run lint
npm run build
npm run scan         # the official n8n community-package scanner
npm run pack:check   # what publishing would upload
```

`test/fixtures/contract-vectors.json` holds deliveries signed by the real Core
Events signer. They are static fixtures: this package has no dependency, at
build time or run time, on the Comers repositories. The file records how it was
produced, so it can be regenerated if the signing contract ever moves.

### Contributing

- Use the `n8n-node` CLI for building, linting and dev mode. It is what n8n
  itself checks against, and `npm run lint` runs in strict mode, so a change
  that passes locally passes verification.
- Keep `dependencies` empty. Verified community nodes may not have runtime
  dependencies, and `node:crypto` is the only module this node needs.
- Do not read environment variables or touch the filesystem. Both are
  disallowed, and the linter enforces it.
- If you change the version, update `CHANGELOG.md` in the same commit.

### Releasing

A release has two halves. Something creates a tag; the publish workflow reacts
to it. The workflow never versions, commits or tags — the only thing that
changes the repository is the half that runs before it.

Pushing a release tag starts `.github/workflows/publish.yml`, which re-runs
lint, build, tests, the scanner and the tarball check, confirms the tag names
the version in `package.json`, and publishes with npm provenance over Trusted
Publishing. It reads no secret — there is none to read.

Publishing from a developer machine is refused outright — a package published
that way carries no provenance attestation and could never become a verified
community node, while still burning the version number.

#### Tag format

Tags are the bare version, with no `v` prefix and no build metadata:

| | |
| --- | --- |
| Accepted | `0.1.0`, `1.2.3`, `2.0.0-rc.1` |
| Refused | `v0.1.0`, `1.2.3+build.4`, a tag naming a different version than `package.json`, anything that is not a version |

The format is pinned by the `release-it` block in `package.json` rather than
inferred from whatever tags already exist, and `npm run check:tag` enforces it.

The workflow's own tag filter is deliberately the looser of the two — a GitHub
ref filter treats `+` as a quantifier rather than a literal, so it cannot
exclude a tag for carrying build metadata. Every tag the check accepts starts a
run, so a valid release is never silently ignored; a malformed one that slips
past the filter fails the check loudly instead.

#### Every release

```sh
npm run release -- 0.1.1
```

The version is mandatory: `npm run release` with nothing after it refuses to
run rather than choosing a patch bump for you.

That command runs the same checks the publish pipeline does — lint, build,
tests, the n8n scanner and the tarball check — then sets the version in
`package.json` and `package-lock.json`, moves whatever is written under
`## Unreleased` in `CHANGELOG.md` into a dated `## 0.1.1 — YYYY-MM-DD` section,
makes one commit `chore: release 0.1.1`, creates the annotated tag `0.1.1`, and
pushes both.

Released sections are carried over byte for byte. Code blocks, indentation,
blank runs and trailing spaces in earlier entries are left exactly as they were
written: they are a published record, not this script's to reflow.

**It never publishes.** Pushing the tag starts
`.github/workflows/publish.yml`, which re-runs every check against the tagged
commit, confirms the tag names the version in `package.json`, and publishes over
Trusted Publishing — no token, no secret, nothing to rotate. The local command
needs no npm credential and no GitHub token.

If anything is not right — uncommitted changes to tracked files, the wrong
branch, no upstream, nothing new since the last tag, an empty `## Unreleased`,
or a section for that version already present — the release stops before any
commit or tag exists.

Every predictable refusal happens before a single file is written — the
version-specific ones too, since release-it makes the version available to the
`before:bump` hook. A refused release leaves the working tree exactly as it was.

One thing worth knowing: "clean working tree" means no uncommitted changes to
**tracked** files. Untracked files do not stop a release, and cannot reach it
either — the release commit stages only tracked changes, and `npm run pack:check`
asserts what the tarball contains.

`n8n-node release` is not used here. It passes
`--hooks.after:bump="npx auto-changelog -p"` as a command-line argument, and in
release-it a command-line argument overrides configuration, so a project cannot
opt out of it. Rebuilding the changelog from commit subjects is a sensible
default for a generated changelog; this one is written by hand and says why
things changed, so the project drives release-it itself and keeps the file. The
settings live in the `release-it` block of `package.json`,
`scripts/release.mjs` is the wrapper that makes the version mandatory, and
`scripts/finalize-changelog.mjs` is the hook that checks and dates the notes.

#### How 0.1.0 came to exist

Published on 11 September 2026, and the only release that did not follow the
procedure above.

npm Trusted Publishing is configured *on a package*, so there was nothing to
configure until the package existed. 0.1.0 was therefore published from this
same workflow, on a GitHub-hosted runner and with `--provenance`, but
authenticated with a single-use granular token rather than OIDC.

That token has since been revoked and the GitHub secret holding it deleted, and
the Trusted Publisher is in place. Nothing in this repository reads a
credential any more, and no release will need one again — which is why the
bootstrap path is gone from `publish.yml` rather than kept around disabled.

## Licence

[MIT](LICENSE)
