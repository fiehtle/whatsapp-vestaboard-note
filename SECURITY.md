# Security

## Boundary

This repository contains reusable source and synthetic fixtures. A clone has no
connection to an existing installation. Each operator must provide their own
accounts, credentials, phone numbers, deployment and private storage.

The intended trust model is one board and a small set of trusted senders. Public
multi-tenant hosting, arbitrary webhooks and untrusted administrators are outside
scope. Source visibility is not authorization: every state-changing entry point
must verify credentials independently.

## Protections

- Admin access requires an independent random bearer token. Missing keys fail
  closed. The browser accepts a password-style token input, stores it only in
  session storage and offers Lock setup; no secret-bearing setup URLs are needed.
- Incoming Kapso webhooks require an exact raw-body HMAC-SHA256 signature. The
  destination number, inbound event and sender allowlist must all match.
- Recovery requires a separate cron bearer token. Queue callbacks use Vercel's
  queue SDK and its authenticated message-claim path, not a public custom sender.
- Configuration is AES-256-GCM encrypted before writing to a PRIVATE Blob store.
  The encryption key is a server environment secret. No endpoint returns saved
  provider credentials. Admin status contains household numbers and message
  details and must remain authenticated.
- Provider destinations are fixed. Credential-bearing requests reject redirects.
  Audio downloads accept only Kapso's exact HTTPS media-download origin/path,
  reject redirects and enforce media/size limits. Message URLs are never fetched.
- LLM input is the user's message plus public device instructions. No credentials
  or environment contents are included; no executable tools are exposed.
- Responses use no-store headers. The UI renders untrusted text with textContent;
  CSP disallows inline/evaluated scripts, external script sources and framing.
- First-party error logging omits request bodies, phone numbers, credentials and
  provider response bodies. Tests/evals must use invented messages.

## Data and remaining risks

The private inbox contains pending message text/audio identifiers, transcripts,
saved layouts and progress. Completed entries are removed, but the last displayed
message/layout and recent deduplication IDs remain. These state records are private
Blob data, not additionally encrypted by this application. Raw downloaded audio
exists only during the worker invocation. Kapso, WhatsApp, Vercel and AI providers
have their own storage/retention practices; inspect those before sending sensitive
content. Long messages and audio/transcripts may be sent to AI providers.

A bearer token grants admin access. Anyone who obtains it, a provider key or cloud
account access can exceed the intended trust boundary. Browser extensions, a
compromised operator machine, malicious reviewed dependencies or leaked CI
credentials are not solved by this repository. Do not put secrets into untrusted
agent sessions. Do not expose production resources to public PR builds.

AI may summarize incorrectly or follow a sender's display instructions in an
unexpected way; it cannot retrieve server secrets through the formatter. Provider
failures, quotas, denial-of-service and exhausted credits can interrupt delivery.
Daily caps are not a hard financial limit. Use provider budgets and account
controls for your deployment. No penetration-test certification or guarantee of
absence of vulnerabilities is claimed.

## Before publishing a fork

1. Use a new repository/history when extracting from a private deployment.
2. Stage only source, docs and synthetic tests. Run `npm run check:public`.
3. Run a secret scanner over the staged export AND all reachable Git history,
   e.g. [Gitleaks](https://github.com/gitleaks/gitleaks):
   `gitleaks git . --redact --no-banner`.
4. Check all branches/tags, commit author emails, attachments, CI artifacts and
   repository settings. An ignore file does not remove existing Git history.
5. Enable GitHub secret scanning/push protection where available. Never store
   production credentials in this public repository's Actions secrets.

The publication guard catches common files and configuration leaks; it cannot
know every operator's personal data. Review your own changes before pushing.

## Reporting

Use this repository's **Security -> Report a vulnerability** private reporting
form if available. Do not post tokens, phone numbers, transcripts, deploy URLs or
working exploits against somebody else's installation in public issues. Use a
minimal synthetic reproduction. If private reporting is unavailable, open an
issue asking for a private contact channel without disclosing the vulnerability.

If you exposed a credential, revoke/rotate it at the provider immediately; deleting
it from a branch does not undo an exposure. Remove it from reachable history and
artifacts, inspect authorized activity, then issue new independent credentials.
