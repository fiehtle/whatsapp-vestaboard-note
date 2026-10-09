# Operating your installation

## Runtime map

| Path | Role |
| --- | --- |
| `api/kapso.js` | Raw-body signature verification, sender filtering, durable admission |
| `lib/inbox.mjs` | FIFO inbox, CAS updates, lease, checkpoints, quotas and retries |
| `api/deliver.js` | Vercel Queue consumer; do not replace with an unsigned webhook |
| `lib/storage.mjs` | Private Blob records and encrypted configuration |
| `lib/format.mjs` | Short-text bypass; validated mini-model output, stronger fallback |
| `lib/voice.mjs` | Authenticated Kapso media and transcription fallback |
| `lib/note.mjs` | Note glyphs, wrapping, centering and deterministic decoration |
| `lib/preview.mjs` | Fixed 3 × 15 SVG/PNG renderer with bundled font |
| `lib/feedback.mjs` | Allowed-sender text notices and private WhatsApp image upload/send |
| `lib/board.mjs` | Fixed Vestaboard Cloud API destination and Note verification |
| `api/recover.js` | Authenticated daily recovery |
| `api/admin.js` | Authenticated settings, tests, status, board readback and diagnostics |
| `api/health.js` | Public, minimal readiness response without private details |

## Delivery and recovery

A webhook first saves the message with a conditional Blob write, then publishes a
queue wake-up, then acknowledges HTTP 200. Publication failure leaves the saved
entry and returns a retryable response. Duplicate events reuse the admission.

A six-minute persistent lease prevents simultaneous board writers. Transcription,
formatting and exact character arrays are checkpointed so board retries do not
regenerate them. After each confirmed write the page index advances; callbacks
may still repeat a write after an uncertain crash. The consumer's maximum runtime
is five minutes. The last accepted array is available to the authenticated admin.

After the final page is accepted and checkpointed, the worker sends its exact
saved layout back as a PNG image. The 3 × 15 geometry is fixed inside the image,
so phone font size and emoji rendering cannot wrap the preview. The renderer uses
the bundled OFL font and no image-generation model. Previews approximate hardware
appearance; they do not observe physical flap movement.

The PNG exists in memory and uploads directly through Kapso to WhatsApp; its media
ID is then sent to the original authorized sender. No public preview URL or local
image archive is created. Replies are attempted at most once within 23 hours of
the inbound message. An uncertain reply is not automatically resent; a reply
failure records a generic error and never repeats an accepted board write.

Provider failures publish delayed retries (30 seconds, increasing to one hour).
An uncertain board response retains the safety lease. New admissions and the daily
cron can revive a saved head whose callbacks expired/exhausted. Daily recovery is
an additional fallback; ordinary delivery is event-driven. Vercel's Hobby cron may
run within the scheduled hour, not precisely at its first minute. See [cron docs](https://vercel.com/docs/cron-jobs/usage-and-pricing).

`GET /api/recover` requires `Authorization: Bearer <CRON_SECRET>`. Vercel supplies
the header for scheduled runs. It respects the active lease/backoff and does not
replay completed jobs. The admin action `retryPending` uses the same recovery.

## Health and diagnosis

`GET /api/health` returns 200 only when credentials/allowlist are configured,
private storage is readable, no inbox head has waited over 15 minutes, and no
recorded recovery heartbeat is older than 26 hours. It returns 503 otherwise.
A budget pause can therefore correctly show degraded health. It does not call
every provider, confirm Wi-Fi/flap movement or send alerts. Configure an external
monitor yourself if you need notifications.

Check, in order:

1. Number connectivity and signed webhook delivery in **your Kapso project**.
2. Private setup: pending messages, last accepted text, delivery/reply errors.
3. Runtime logs for **your Vercel project**. Do not export secrets or payloads.
4. Queue diagnostic and cron status. Vercel queues must have a registered consumer.
5. AI Gateway credits/authentication for long text or voice failures.
6. Vestaboard Cloud API and the device's power/Wi-Fi.

An authenticated `POST /api/admin` accepts these JSON actions:

| Action | Effect |
| --- | --- |
| `diagnostic` | Sends a harmless queue diagnostic; GET status exposes its processed timestamp |
| `retryPending` | Requeues an eligible oldest saved message |
| `read` | Reads the Note's current cloud array |
| `preview` | Returns a private, uncached PNG of the current cloud array; sends no message |
| `test` with `text` | Writes a REAL message through the persistent inbox |
| `save` | Updates supplied configuration fields; blank secret fields retain existing values |

Use your existing private token without printing it or embedding it in URLs. Never
send a real test or trigger recovery against another operator's resources.

## Secrets and storage

Keep a secure backup of `CONFIG_ENCRYPTION_KEY`. Routine rotation requires decrypting
with the old key and re-encrypting with the new key in a controlled maintenance
window; blindly replacing it makes existing config unreadable. This repository
contains no automatic rotation tool. Backups contain private information and must
not be committed or uploaded to public issues.

Rotate `ADMIN_TOKEN` and `CRON_SECRET` in your Vercel environment and redeploy.
Existing browser sessions then need the new admin token. For a Kapso webhook
secret change, update both the Kapso webhook and encrypted app settings. A short
mismatch window may cause failed deliveries, so check pending provider retries.
Update API keys via private setup. Do not rotate unrelated accounts or deployments.

## Updates

Review upstream changes and run the local tests before deploying. Verify
`.vercel/project.json` refers to YOUR intended team/project. Deploy with
`vercel deploy --prod`, check health and logs, then confirm the physical board.
Never pull production credentials into an untrusted checkout. Keep preview and
production Blob stores separate; their fixed state object names would otherwise
make them operate on the same inbox.

For the image-preview update, install the updated lockfile and deploy the bundled
`assets/fonts/` along with the new functions. Keep their `includeFiles` entries in
`vercel.json`. No new environment variable or state migration is needed. If images
fail while the board updates, inspect `lastFeedbackError`, the Kapso key's media
upload permission, and the authenticated `preview` action. Do not publish the
returned image or private runtime logs as troubleshooting attachments.
