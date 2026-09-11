# n8n-nodes-comers

Receive signed [Comers](https://github.com/rocketdeploy-dev) domain events in
[n8n](https://n8n.io).

This package contains one trigger node and one credential:

| | |
| --- | --- |
| **Comers Trigger** | Starts a workflow when Comers delivers an event. Verifies the delivery's signature before the workflow runs. |
| **Comers Webhook Secret API** | Holds the signing secret for one webhook subscription. Nothing is ever sent to Comers with it. |

The node only receives. It never creates, changes or removes a subscription in
Comers — you do that yourself in Business Settings, as described below.

## Installation

In n8n, go to **Settings → Community nodes → Install** and enter
`@comers/n8n-nodes-comers`.

## Setting up a subscription

Comers and n8n each hold one half of the setup, and neither can complete it
alone: n8n produces the URL, Comers produces the secret.

### 1. Add the trigger

Add a **Comers Trigger** node to a new workflow. It takes no parameters.

### 2. Pick the URL you are going to register

The trigger shows two webhook URLs, and they are not interchangeable.

- The **test URL** only listens while you have clicked *Listen for test event*
  in the editor. Deliveries appear in the editor so you can see the event
  shape. Between listens, this URL does not exist and Comers gets a 404.
- The **production URL** works whenever the workflow is published. Executions
  appear in the executions list.

Use the test URL while you are building, then register the production URL when
you publish. A subscription's target URL cannot be changed afterwards, so a
subscription registered against a test URL has to be archived and recreated.

### 3. Create the subscription in Comers

In Comers **Business Settings → Webhook subscriptions**, create a subscription:

- paste the webhook URL you copied from the trigger,
- choose the events you want,
- choose the scope.

Comers shows the **signing secret once**, on this screen, and can never show it
again. Copy it now. If you lose it, rotate the secret in Business Settings to
get a new one.

### 4. Store the secret in the credential

Back in n8n, create a **Comers Webhook Secret API** credential and paste the
secret into **Signing Secret**. Select it on the trigger node.

One credential belongs to one subscription. Two subscriptions have two secrets,
so they need two credentials.

The credential's *Test* button checks only that the value has the shape Comers
issues — 43 characters of base64url. It sends nothing to Comers, and it cannot
tell you whether this is the secret for *this* subscription. The first delivery
tells you that.

### 5. Publish the workflow

Until the workflow is published, the production URL answers 404. Comers retries
a 404 for a while, then suspends the subscription, so publish before you expect
deliveries.

## Rotating the secret

When you rotate a subscription's secret in Business Settings, Comers signs each
delivery **twice** for the length of the overlap window: once with the old
secret and once with the new one. The node accepts a delivery if either
signature matches, so deliveries keep arriving while you paste the new secret
into the credential.

Update the credential before the overlap window closes. After it closes, only
the new secret is offered.

## Stopping

**Deactivating or deleting the workflow does not stop Comers.** This node has
no credential that would let it talk to the Comers API, so it cannot suspend
anything on your behalf. Comers keeps delivering, receives 404s, and eventually
suspends the subscription itself after repeated failures.

If you mean to stop: **suspend the subscription in Business Settings first**,
then deactivate the workflow. Resume it in Business Settings when you are ready
again.

## What the workflow receives

A verified delivery produces exactly one item, with two keys:

- **`event`** — the Comers envelope, exactly as it decoded from the
  authenticated bytes. Nothing is renamed, removed, added or overwritten.
- **`delivery`** — how this delivery reached you. These facts travel in headers
  rather than in the envelope.

```json
{
  "event": {
    "specVersion": "comers.v1",
    "eventId": "0199c3f0-1a2b-7c3d-8e4f-000000000001",
    "eventKey": "support.case.opened",
    "eventVersion": 1,
    "sequence": "9007199254740993",
    "occurredAt": "2026-09-11T07:05:30.000Z",
    "producer": "comers-core-support",
    "scope": {
      "organizationId": "0199c3f0-1a2b-7c3d-8e4f-00000000000a",
      "sellerId": null,
      "sellerStoreId": null
    },
    "subject": { "type": "support_case", "id": "0199c3f0-1a2b-7c3d-8e4f-00000000000b" },
    "correlationId": "0199c3f0-1a2b-7c3d-8e4f-00000000000c",
    "data": { "caseId": "0199c3f0-1a2b-7c3d-8e4f-00000000000b", "priority": "high" }
  },
  "delivery": {
    "subscriptionId": "0199c3f0-1a2b-7c3d-8e4f-000000000002",
    "deliveryId": "0199c3f0-1a2b-7c3d-8e4f-000000000003",
    "deliveryAttempt": 0,
    "timestamp": 1788259530
  }
}
```

So in expressions:

```
{{ $json.event.eventId }}
{{ $json.event.eventKey }}
{{ $json.event.data }}
{{ $json.delivery.deliveryAttempt }}
```

The two are kept apart so that neither can shadow the other. If they were
merged and Comers later added a field of its own named `delivery`, it would
silently disappear behind this node's transport metadata. Under `event`,
anything Comers adds arrives untouched.

What is verified byte for byte is the **request body**, before anything is
parsed. `event` is the value those bytes decode to. The node changes none of
it, but a JSON value is not a byte string: re-serialising `event` will not
necessarily reproduce the bytes that were signed, and nothing here promises it
would. If you need to re-verify a signature, you need the original bytes, not
this item.

### What the signature actually covers

The signature is computed over `v1:<timestamp>:<raw body>`. That means:

- Everything under **`event`** is authenticated, as is `delivery.timestamp`.
- **`delivery.subscriptionId`, `delivery.deliveryId` and
  `delivery.deliveryAttempt` are not.** They travel in headers, appear nowhere
  in the body, and the HMAC does not bind them. HTTPS protects them in transit;
  the application-level signature does not.

So treat those three as routing and bookkeeping — matching a delivery against
the Comers delivery log, or telling a first attempt from a retry. Do not build
an authorization or authenticity decision on them. What makes the domain fact
genuine is the signed body together with its signed timestamp.

The routing headers `X-Comers-Event-Id`, `-Event-Key` and `-Event-Version` are
outside the signature too. The node compares each of them against the
authenticated body and refuses the delivery when they disagree, so a header
altered in flight cannot point a workflow at an event the body does not
describe.

Two things about the payload:

- `sequence` is a **decimal string**, not a number. It is a 64-bit counter, and
  JSON numbers lose precision past 2^53−1. Compare it as a string, or parse it
  as a `BigInt`.
- `event.data` is the domain payload and is passed through untouched. The node
  validates the common envelope — the protocol fields and their types — not the
  contents of `data`, so Comers can add a field or a whole new event type
  without this node needing a release.

### Write idempotent workflows

Delivery is **at-least-once**. A delivery that Comers could not confirm is
retried, so the same `event.eventId` can arrive more than once — after a
network timeout, after a replay from Business Settings, or after a slow
response.

The node deliberately keeps no record of what it has seen. It is a stateless
receiver, and a per-instance memory of event ids would be wrong the moment you
ran a second n8n or restarted the first.

Make the workflow idempotent on `event.eventId`: look it up before acting, or
make the action itself safe to repeat. `delivery.deliveryAttempt` tells you
which attempt you are looking at, but it is not a substitute — attempt 0 can
still arrive twice.

## How a delivery is verified

Comers signs the exact bytes of the request body:

```
HMAC-SHA256(secret, "v1:<timestamp>:<raw body bytes>")
```

base64-encoded, offered in `X-Comers-Signature` as `v1=<signature>`, with more
than one offered during a secret rotation.

The node recomputes this over the bytes that arrived, using Node's built-in
`node:crypto` and a constant-time comparison, and only then parses the JSON. A
delivery it cannot verify never reaches the workflow.

The timestamp is inside the signed string rather than beside it, so a captured
delivery cannot be replayed later under a fresh timestamp. The node accepts a
timestamp within **±300 seconds** of its own clock. That window is fixed and
not configurable.

### Response codes, and what Comers does with them

| The node answers | When | What Comers does |
| --- | --- | --- |
| `200` | The delivery verified and the workflow started | Marks the delivery delivered |
| `401` | No signature, a signature that does not match, a signature scheme it does not understand, a malformed timestamp, or a timestamp outside the window | Treats it as a contract fault: **no retries**, the delivery goes straight to dead letters |
| `400` | The signature verified, but the body is not JSON or not a valid Comers envelope | The same: **no retries**, straight to dead letters |
| `500` | Something unexpected broke inside the node — most often a missing or unreadable credential | Retries on the normal schedule |

A `401` or `400` is deliberate. A wrong secret and a skewed clock do not get
better by being retried six times over the next day; they need somebody to fix
something. Sending the delivery to dead letters puts it where that person will
see it, and keeps it replayable.

So when deliveries stop arriving:

1. Look at the delivery log in Business Settings. Dead letters with `401` mean
   the secret in the credential is not the one Comers is signing with, or the
   two clocks are more than five minutes apart.
2. Fix it — paste the current secret, or fix the clock on the host running n8n.
3. **Replay** the dead letters from Business Settings. Nothing is lost by
   having been rejected.

A `500` is retried, so a credential you forgot to attach fixes itself once you
attach it.

## Credentials

**Comers Webhook Secret API** holds one field:

| Field | |
| --- | --- |
| **Signing Secret** | The secret Comers showed once when the subscription was created or its secret was rotated. |

This is not an API credential and not OAuth. The secret is never sent anywhere:
it is used only to recompute the HMAC of an incoming delivery. It is stored
encrypted by n8n, never written to the workflow, never included in the item the
node emits, and never written to the log.

## Automatic subscription management

Version 0.1.0 does not create, update or remove subscriptions in Comers. Doing
that would mean calling the Comers API, which needs an authenticated contract
this node does not have and a safe place to put the secret that such a call
would return. Both are open questions, not oversights, and they are being
worked on separately.

Until then the setup is the manual one described above, and it is complete as
it stands: nothing here is waiting on a later release to work.

n8n requires every webhook trigger to declare a registration lifecycle
(`checkExists`, `create`, `delete`). This node implements all three as
no-ops — they perform no I/O and contact nothing. That is why deactivating the
workflow does not suspend the subscription.

## Compatibility

**Verified with n8n 2.38.6** — installed from a locally packed npm tarball and
exercised end to end: activation, deactivation and reactivation, the full
signature and envelope matrix, and the credential test.

Expected to work on any n8n that supports community nodes with
`n8nNodesApiVersion: 1`, but no other version has been tested, so treat that as
an expectation rather than a claim. Requires Node.js 20 or newer, which n8n
already does.

The package has no runtime dependencies. It reads no environment variables and
touches no files.

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
the version in `package.json`, and publishes with npm provenance. Every release
after the first authenticates over Trusted Publishing and uses no secret; the
first one cannot, for the reason below.

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

#### The first release (0.1.0)

The first release is unlike every one after it, in two ways.

It cannot come from `npm run release`, which bumps the version *before* tagging:
`package.json` already says 0.1.0, so the next bump would be 0.1.1.

And it cannot authenticate the way later releases do. **npm Trusted Publishing
is configured on a package, so there is nothing to configure until the package
exists.** The first publish is therefore the one and only time a token is
involved — a short-lived granular token, used once and then destroyed.

It still publishes from GitHub Actions with `--provenance`, like every other
release. Only the authentication differs.

1. Merge the PR to `main` with `package.json` at `0.1.0`.
2. Create or confirm the `@comers` scope on npm.
3. Create a granular access token allowed to publish a new public package in
   that scope.
4. Enable 2FA on the npm account and configure the token to npm's current
   requirements for automated publishing.
5. Save it as the GitHub Actions secret `NPM_BOOTSTRAP_TOKEN`.
6. Tag the merge commit, changing no files:
   ```sh
   git tag -a 0.1.0 -m "Release 0.1.0"
   ```
7. Push the tag, and only the tag:
   ```sh
   git push origin 0.1.0
   ```
8. The workflow publishes 0.1.0 with `--provenance --access public`.
9. Now that the package exists, add a Trusted Publisher to it — owner
   `rocketdeploy-dev`, repository `n8n-nodes-comers`, workflow `publish.yml` —
   and allow direct `npm publish`.
10. Delete `NPM_BOOTSTRAP_TOKEN` from the repository's secrets.
11. Revoke the granular token on npm.
12. From then on every release authenticates over OIDC and uses no secret.

Steps 10 and 11 are not housekeeping to get to later. Once Trusted Publishing
is in place the token is a long-lived publish credential that no workflow path
still needs, which is exactly what Trusted Publishing exists to remove.

The workflow enforces the split: the bootstrap step runs only for the tag
`0.1.0` and is the only place the secret is named, and it fails outright if the
secret is missing rather than falling through to an OIDC path that could not
work yet. Every other tag takes a publish step that references no secret at all.

#### Every release after that

```sh
npm run release
```

bumps the version, writes the changelog, commits, tags and pushes, which starts
the workflow.

## Licence

[MIT](LICENSE)
