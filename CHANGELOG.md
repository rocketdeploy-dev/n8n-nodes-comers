# Changelog

## 0.1.0 — unreleased

First release.

- **Comers Trigger**: a receive-only webhook trigger that verifies each
  delivery's HMAC-SHA256 signature over the exact request bytes before the
  workflow runs, and emits one item per verified delivery as
  `{ event, delivery }`.
- **Comers Webhook Secret API**: an encrypted credential holding one
  subscription's signing secret. It is never sent anywhere.
- Subscriptions are created and managed by hand in Comers Business Settings.
  The node's webhook lifecycle hooks are no-ops and contact nothing.
