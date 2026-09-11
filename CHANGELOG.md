# Changelog

## Unreleased

Release infrastructure only; the published package is unchanged.

- Publishing is now Trusted Publishing (OIDC) alone. The one-time granular
  token that bootstrapped 0.1.0 — needed because a Trusted Publisher cannot be
  configured for a package that does not exist yet — has been revoked, its
  GitHub secret deleted, and its path removed from the publish workflow.

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
