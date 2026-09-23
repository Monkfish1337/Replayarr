# Replayarr

**Your sports. On replay.**

Replayarr is a self-hosted manager for sports event recordings, in the style of Sonarr. You request an event, Replayarr searches your indexers, you pick a release, and it tracks the download through to a named file in your media library.

It is a separate project from [SeriousSportSync](https://github.com/Monkfish1337/Serioussportsync). SSS is a sports calendar and streaming add-on; Replayarr keeps a durable local library. Replayarr reads SSS's calendar but never writes to it, and its release matching is ported from SSS (see [Matching](#matching)).

> **Phase 1.** The manual loop works end to end: request → search → review → download → import. Automatic grabbing, quality upgrades and media-server notifications come later.

## Run it with Docker (Dockge)

Each push to `main` or a `phase-*` branch is tested and published to `ghcr.io/monkfish1337/replayarr` for amd64 and arm64. Tags: `latest` (main), the branch name (e.g. `phase-1`), and `sha-<commit>`.

**[docs/DOCKGE.md](docs/DOCKGE.md)** walks through creating the stack from [`docker-compose.yml`](docker-compose.yml) and [`.env.example`](.env.example).

## Run it with Node

Requires Node.js 22.13 or newer. There are no npm dependencies.

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173), then go to **Settings** and connect:

| Settings page | What to enter |
| --- | --- |
| Metadata Source | Your SSS addon install URL (ends in `/manifest.json`, from your SSS account page) |
| Indexers | Any mix of Prowlarr instances, Bitmagnet and Easynews |
| Download Clients | qBittorrent and/or SABnzbd, plus remote path mappings if they run in other containers |
| Media Management | The library folder Plex, Jellyfin or Emby scans, and the naming pattern |

Each connection has a **Test** button. **System › Status** lists anything still missing.

```sh
npm test
```

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` in a container |
| `REPLAYARR_DB` | `data/replayarr.db` | SQLite database file |
| `REPLAYARR_USERNAME`, `REPLAYARR_PASSWORD` | unset | Require HTTP Basic login. Set these whenever `HOST` is not localhost |
| `REPLAYARR_TICK_MS` | `30000` | How often the worker searches due requests and checks downloads |
| `REPLAYARR_WORKER` | on | `off` disables the background worker |

## How it works

The UI follows Sonarr: **Promotions** stand in for series, **events** for episodes, and **requesting** an event is monitoring it.

```text
Event ─▶ Request (wanted) ─▶ Search ─▶ Candidates ─▶ Review ─▶ Download job ─▶ Import ─▶ Library
```

- **Events** come from SSS's existing addon catalog (read-only) or are added by hand. Requesting one fetches its aliases and start time from SSS.
- **Searching** waits until 3 hours after the event starts, then sends the promotion's search titles to every enabled indexer, most precise first, up to each indexer's *Queries Per Search*. Indexers can be any number of Prowlarr instances, Bitmagnet (GraphQL, ordered by seeders) and Easynews. A release reported by several indexers is listed once. When nothing matches it backs off: 30 minutes, 2, 6 and 12 hours, then daily.
- **Candidates** pass SSS's release filter and the promotion's matcher. Rejected releases stay visible in Interactive Search with the reason, such as `wrong-date` or `sports-noise`, but cannot be grabbed. Matches are scored from quality, source, seeders and protocol, and each score shows how it was reached.
- **Review** is manual in Phase 1: choose a release from Interactive Search. A torrent goes to qBittorrent and an NZB to SABnzbd. An Easynews result is a single file over HTTPS, so Replayarr's built-in downloader fetches it into that indexer's download folder (two at a time, resuming after a restart); Easynews credentials only ever go to easynews.com.
- **Import** uses the largest non-sample video. It checks the minimum size and that the file name does not name a different date or event. It then hardlinks, copies or moves the file to `{promotion}/Season {year}/{promotion} - {date} - {title} [{quality}]`. Imports are idempotent, and a half-copied file never appears under its final name.

State lives in SQLite. Request status changes only through an explicit transition table, so no code path can mark a request ready without an import.

## Matching

`src/matching/` is ported from SSS (`lib/promotions.js`, `promotion-aliases.js`, `team-identities.js`, `team-alias-presets.js`, `sources/release-filter.js` at SSS `0706d4d`), with SSS's matcher tests in `test/matching/`. That covers every built-in SSS promotion: UFC, ONE, WWE and AEW shows, F1, MotoGP, boxing, Match of the Day, UCL, MLB, NFL, NBA and the Premier League. It also brings the team alias presets and SSS's rules against false positives.

Under **Settings › Promotions** you can add learned aliases to a built-in promotion or create a custom one. **Suggest From Examples** runs SSS's alias learner on real release names you paste in.

When SSS's matching improves, port the change into `src/matching/` and its tests. Don't make Replayarr depend on SSS's code at runtime.

## Architecture boundaries

| Concern | Owner |
| --- | --- |
| Calendar and event identity | SSS (read through its public addon endpoints) |
| Release matching rules | Ported from SSS into Replayarr |
| Wanted events, download decisions and job history | Replayarr |
| Actual transfer | qBittorrent / SABnzbd |
| File placement and naming | Replayarr importer |
| Playback | Your media server |

See [docs/phase-1.md](docs/phase-1.md) for the data model, API and what comes next.

## License

MIT. See [LICENSE](LICENSE).
