# Integrations

External integration adapters live here.

## File

- `PartnerWebhookRelay.js`

## What it does

- Sends outbound POST webhooks to partner backend
- Adds event metadata headers (`X-SDK-Event`, `X-SDK-Event-Id`, `X-SDK-Timestamp`)
- Optionally signs body using HMAC SHA-256 (`X-SDK-Signature`)
- Retries with exponential backoff + jitter on retryable failures
- Supports event allowlist via `PARTNER_WEBHOOK_EVENTS`
