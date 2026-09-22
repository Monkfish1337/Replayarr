# Prototype layout and next build steps

## Screens

- **Overview** — counts for wanted, review, in-progress, and library-ready requests; immediate actions and recent events.
- **Discover** — promotion filters and event search. Requesting an event creates one durable wanted record; repeating the action must not duplicate it.
- **Requests** — visible lifecycle from queue to ready. The prototype's “Simulate next step” control stands in for a search worker or download-client callback.
- **Release review** — compare candidates by title, source, size, quality, and match score before choosing one. A real build should also show *why* a candidate matched or failed.
- **Activity** — human-readable event and job history.
- **Settings** — future adapter boundaries for metadata, indexers, download clients, and media-library import.

All event names, titles, scores, client states, and activity entries in this version are illustrative demo data.

## Proposed records

| Record | Key fields | Purpose |
| --- | --- | --- |
| Event | id, promotion, title, start time, teams, aliases, source revision | Stable identity independent of release naming |
| Wanted request | id, event id, profile, status, created by, timestamps | One user's or one policy's acquisition intent |
| Search attempt | id, event id, source, query, result count, duration, error, next retry | Control indexer load and explain gaps |
| Candidate | id, event id, source, title, guid/hash/NZB identity, score, evidence | Compare releases and prevent duplicate grabs |
| Download job | id, candidate id, client id, remote id, state, path, error | Reconcile external client state |
| Library item | id, event id, file path, quality, size, checksum, imported at | Know what is actually available |

The UI should never infer a successful import solely from a successful indexer search or a download-client “completed” flag. The file must exist and pass minimum verification first.

## Integration sequence

1. **Metadata:** define a versioned event payload and import job. Cache events locally; keep source provenance and timezone-aware start time. Avoid TSDB calls on each page load.
2. **Discovery:** adapt SSS's promotion matching and aliases; add bounded queues, source budgets, retry/backoff, and query/outcome metrics. Do not run a live Prowlarr search on every UI visit.
3. **Requests:** add SQLite persistence, explicit state transitions, and an append-only activity record. Start with manual requests and manual release approval.
4. **Clients:** implement one torrent client and one Usenet client behind a common interface; reconcile by remote job ID and handle restarts.
5. **Importer:** stage the completed file, verify media and event identity, then copy/hardlink/move according to a configured policy. Make imports idempotent.
6. **Automation:** only after the manual loop works, add monitored promotions, profiles, upgrades, and missing-event retries.

## Questions to resolve during implementation

- Which download clients should be the first supported pair?
- Should Replayarr consume an SSS API, a periodic export, or extracted shared matching code?
- Which naming layout should Plex/Jellyfin receive by default?
- Should requests be per user, per household, or a single administrator-managed queue?

These choices do not block the UI prototype.
