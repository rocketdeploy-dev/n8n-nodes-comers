# Changelog

## Unreleased

## 0.1.1 — 2026-09-12

### Fixed

- `delivery.deliveryAttempt` is now required to be a whole number of at least
  **1**. Core Events raises the attempt counter as it claims a delivery, so the
  first request already carries 1. The node previously accepted 0 — a transport
  state the real dispatcher never emits.

### Changed

- Examples, fixtures and contract vectors now use the canonical event key
  `comers.core.support.case.opened`, as defined in the Core Events catalog,
  rather than the shortened `support.case.opened`. The node still validates no
  event key against a list: an unknown or future key is accepted as long as the
  common envelope is valid.
- The README now distinguishes a `400` answered by the node, after it verified
  the signature and rejected the envelope, from a `422` answered by n8n, which
  parses the request body before any node runs and so ends a syntactically
  invalid one before the trigger sees it. Both are terminal 4xx to Comers.
- The README now describes the attempt numbering as the dispatcher implements
  it: 1 upwards within a run, reset to 1 when a replay starts a new run. The run
  is not sent to the receiver, so an attempt number is neither unique nor a
  basis for deduplication — that belongs on `event.eventId`.

### Added

- A dispatcher-conformance test holding one delivery written out literally,
  including the signature Core Events produced for those exact bytes, rather
  than generated from this package's own helpers. The two mismatches above
  survived every existing test because fixture and assertion drifted together.
  This test pins the package to a hand-verified snapshot of the contract and
  fails when the package drifts from it. It does not watch the Core Events
  repository — no test here can. Drift on the other side is caught by an
  end-to-end run against a live dispatcher, or by a contract artefact both sides
  consume.

### Release infrastructure

- Publishing is now Trusted Publishing (OIDC) alone. The one-time granular
  token that bootstrapped 0.1.0 — needed because a Trusted Publisher cannot be
  configured for a package that does not exist yet — has been revoked, its
  GitHub secret deleted, and its path removed from the publish workflow.
- Releases are prepared by `npm run release -- <version>`, a mechanism this
  repository owns. The version is mandatory and never inferred. The hand-written
  `## Unreleased` notes are moved into a dated section, and earlier releases are
  carried over byte for byte rather than rebuilt. The local command only commits
  and tags; publishing stays OIDC-only in GitHub Actions, triggered by the tag.
  `n8n-node release` is not used: it forces a changelog generated from commit
  subjects, which does not fit this repository's hand-written one.

## 0.1.0 — 2026-09-11

First release.

- **Comers Trigger**: a receive-only webhook trigger that verifies each
  delivery's HMAC-SHA256 signature over the exact request bytes before the
  workflow runs, and emits one item per verified delivery as
  `{ event, delivery }`.
- **Comers Webhook Secret API**: an encrypted credential holding one
  subscription's signing secret. It is never sent anywhere.
- Subscriptions are created and managed by hand in Comers Business Settings.
  The node's webhook lifecycle hooks are no-ops and contact nothing.
