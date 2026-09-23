# Phase 1: manual request-to-library loop

## Records

| Table | Key fields | Purpose |
| --- | --- | --- |
| `events` | id (`<promotion prefix>:<id>`), promotion, title, date, time, aliases, source, payload (full normalised record) | Stable identity independent of release naming |
| `requests` | event (unique), status, chosen candidate, search count, next search, error | One acquisition intent per event |
| `search_attempts` | request, queries, results, matched, duration, error | Explains gaps and bounds indexer load |
| `candidates` | request, identity (btih or guid), title, protocol, size, score, decision, reason, evidence | Review and duplicate suppression |
| `jobs` | request, candidate, client, remote id, state, progress, remote path, error | Reconciles download-client state across restarts |
| `library` | event (unique), path, size, quality, release title | What is actually on disk |
| `activity` | request, kind, text | History and System › Events |
| `promotion_rules` | promotion id, kind (`custom`/`overlay`), spec | Operator-learned matching rules |
| `promotion_meta` | promotion id, followed, provider, start date, logo, last refresh result | Metadata choices per promotion |
| `providers` | id, name, source | User-created schedule providers |

Schema changes are appended to `MIGRATIONS` in `src/db.js`; `PRAGMA user_version` records how many have run.

## Request lifecycle

```text
wanted ─▶ searching ─▶ review ─▶ downloading ─▶ importing ─▶ ready
   ▲          │           │           │              │
   └──────────┘ no match  └▶ wanted   └▶ failed ◀────┘
                (back-off)   (search     │
                             again)      ├▶ review  (choose another release)
                                         ├▶ importing (retry a completed download)
                                         └▶ wanted  (search again)
```

`src/store.js` holds the transition table. A request left in `searching` by a restart returns to `wanted` at start-up.

## API

All routes are under `/api`. Writes must be `application/json`, which a cross-site form cannot send without a CORS preflight, and this server grants none.

| Method | Route | |
| --- | --- | --- |
| GET | `/promotions` | Promotions with event/request/library counts |
| GET/POST | `/events` | List (`q`, `promotion`, `from`, `to`) / add manually |
| POST | `/events/sync`, `/metadata/refresh` | Refresh followed promotions (or `{ ids }`) in the background |
| GET | `/metadata/status` | Refresh progress |
| PUT | `/metadata/promotions/:id` | `followed`, `providerId`, `startDate`, `logoUrl` |
| GET | `/metadata/promotions/:id/logos?q=` | Logo candidates |
| POST | `/metadata/promotions/:id/logo` | Upload a logo (`{ dataUrl }`, 2 MB max) |
| GET/POST/DELETE | `/metadata/providers[/:id]` | List, create, delete providers |
| POST | `/metadata/providers/preview` | Test a provider (`{ providerId }` or a draft) and show sample events |
| GET/POST | `/requests` | List / request an event (idempotent) |
| GET/DELETE | `/requests/:id` | Detail with candidates and searches / remove |
| POST | `/requests/:id/search`, `/approve`, `/retry` | Search now, send a candidate, retry a failure |
| GET | `/queue`, `/activity`, `/library`, `/health` | Activity, history, library, health checks |
| GET/PUT | `/settings` | Secrets are masked on read and preserved when the mask is sent back |
| POST | `/settings/test/:service` | `qbittorrent`, `sabnzbd` |
| POST | `/indexers/test` | Test an indexer entry as entered (masked secrets use the saved value) |
| PUT/DELETE | `/promotion-rules[/:id]` | Custom promotions and alias overlays |
| POST | `/promotion-rules/suggest` | SSS alias learner |
| GET/POST | `/system/tasks[/:name]` | `sync-events`, `search-missing`, `check-downloads` |

## Known limits

- One file per event. Multi-part releases (prelims and main card as separate files) import only the largest part.
- No automatic grab, quality profiles or upgrades.
- TheSportsDB refreshes are slow (rate limited, walked round by round); keep start dates recent.
- SQLite cannot open databases on Windows paths longer than 260 characters; keep `REPLAYARR_DB` short.

## Next

1. Automatic grab above a score threshold per promotion, still logging the evidence.
2. Quality profiles and upgrade monitoring.
3. Media-server notifications (Plex/Jellyfin library refresh).
