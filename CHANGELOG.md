# Changelog

## 1.1.0 — 2026-10-09

- Text and voice messages receive a PNG preview after Vestaboard accepts and
  checkpoints the final display. The saved 3 × 15 layout preserves characters,
  blank cells, hearts and color tiles without phone-dependent line wrapping.
- Upload previews directly to WhatsApp through Kapso and send them by media ID;
  no public image storage, image-generation API or new secrets are required.
- Add an authenticated, uncached admin preview action and bundle an OFL font.
- Cover image rendering, recipient authorization, upload failures, duplicate
  callbacks and delivery checkpoint recovery with synthetic tests.
- Strengthen publication checks to inspect staged blobs and reject unreviewed
  binary/media files; verify the bundled upstream font against its checksum.

See the README for upgrade steps. Cloud acceptance does not independently prove
physical flap movement. The public source includes no operator credentials,
private deployment identifiers, real conversations or generated previews.
