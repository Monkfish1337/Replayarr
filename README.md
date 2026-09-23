# Replayarr

**Your sports. On replay.**

Replayarr is a self-hosted manager for sports event recordings, in the style of Sonarr. You request an event, Replayarr searches your indexers, you pick a release, and it tracks the download through to a named file in your media library.

It is a standalone companion to [SeriousSportSync](https://github.com/Monkfish1337/Serioussportsync): SSS is a sports calendar and streaming add-on, Replayarr keeps a durable local library. Replayarr does not need SSS running; its schedule sources and release matching are ported from SSS (see [Metadata](#metadata) and [Matching](#matching)).

> **Phase 1.** The manual loop works end to end: request → search → review → download → import, with Jellyfin metadata. Automatic grabbing and quality upgrades come later.

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
| Metadata › Promotions | Follow the promotions you want (or use **Add New**); set a provider, start date or logo per promotion |
| Metadata › Settings | football-data.org / TMDB / API-Football keys, if a followed promotion needs one |
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

- **Events** come from the schedules of the promotions you follow (see [Metadata](#metadata)), or are added by hand.
- **Searching** waits until 3 hours after the event starts, then asks the enabled indexers in *Priority* order (lowest first; defaults Bitmagnet 10, Easynews 20, Prowlarr 30). Each gets the queries SSS sent it: torrent indexers the promotion's whole torrent list (about 60 for a football fixture: scene forms, alternative club names, team codes like `MUN-SAB`, both date orders), Easynews a few distinct spellings. By default an indexer stops at its first matching release and lower-priority indexers are skipped (*Stop at First Match*); each also has a query limit and a time budget. Indexers can be any number of Prowlarr instances, Bitmagnet (GraphQL, ordered by seeders) and Easynews. A release reported by several indexers is listed once. When nothing matches it backs off: 30 minutes, 2, 6 and 12 hours, then daily.
- **Manual search** (the keyboard button next to automatic and interactive search) sends exactly what you type to one indexer or all of them. Results are still checked against the event; a rejected release can be grabbed anyway after a confirmation that names the reason.
- **Candidates** pass SSS's release filter and the promotion's matcher. Rejected releases stay visible in Interactive Search with the reason, such as `wrong-date` or `sports-noise`, but cannot be grabbed. Matches are scored from quality, source, seeders and protocol, and each score shows how it was reached.
- **Review** is manual in Phase 1: choose a release from Interactive Search. A torrent goes to qBittorrent and an NZB to SABnzbd. An Easynews result is a single file over HTTPS, so Replayarr's built-in downloader fetches it into that indexer's download folder (two at a time, resuming after a restart); Easynews credentials only ever go to easynews.com.
- **Import** uses the largest non-sample video. It checks the minimum size and that the file name does not name a different date or event. It then hardlinks, copies or moves the file to `{promotion}/Season {season}/{promotion} - S{season}E{episode} - {title} [{quality}]` and writes its Jellyfin metadata (see [Media servers](#media-servers-jellyfin)). Imports are idempotent, and a half-copied file never appears under its final name.

State lives in SQLite. Request status changes only through an explicit transition table, so no code path can mark a request ready without an import.

## Matching

`src/matching/` is ported from SSS (`lib/promotions.js`, `promotion-aliases.js`, `team-identities.js`, `team-alias-presets.js`, `sources/release-filter.js` at SSS `0706d4d`), with SSS's matcher tests in `test/matching/`. That covers every built-in SSS promotion: UFC, ONE, WWE and AEW shows, F1, MotoGP, boxing, Match of the Day, UCL, MLB, NFL, NBA and the Premier League. It also brings the team alias presets and SSS's rules against false positives.

Under **Metadata › Matching Rules** you can add learned aliases to a built-in promotion or create a custom one. **Suggest From Examples** runs SSS's alias learner on real release names you paste in.

When SSS's matching improves, port the change into `src/matching/` and its tests. Don't make Replayarr depend on SSS's code at runtime.

## Media servers (Jellyfin)

Online metadata databases don't carry sports events, so Replayarr writes the metadata itself, next to each file:

```text
UFC/tvshow.nfo, poster.*, fanart.*          promotion (poster = the logo you picked)
UFC/Season 2026/poster.*                     the same poster, per season (Jellyfin does not inherit it)
UFC/Season 2026/UFC - S2026E091901 - UFC 331 Van vs Pantoja 2 [1080p].mkv
                .nfo                         title, air date, TheSportsDB description and venue
                -thumb.jpg                   the event's TheSportsDB artwork (fight poster)
```

Each promotion is a show and each year a season. The episode number is the date (MMDD) plus the order that day, so it sorts by date and never changes. In Jellyfin, add a **Shows** library, untick all metadata downloaders and image fetchers, and keep the **Nfo** reader. **Settings › Connect** tells Jellyfin to rescan after imports. **Library › Rename Files** moves events imported under an older pattern, and **Write Metadata** rewrites every .nfo and image (e.g. after picking a new logo).

## Metadata

Replayarr fetches schedules itself, like Sonarr fetches series. **Follow** a promotion (Promotions › Add New, or Metadata › Promotions) and its events are fetched in the background and refreshed every *Refresh Every* hours. Only followed promotions are fetched.

The sources are ported from SSS (`src/metadata/`, SSS `0706d4d`): TheSportsDB (UFC, WWE and its weekly shows, AEW shows, F1, boxing, MotoGP), ESPN (NFL, NBA), MLB's and UEFA's official schedules, the official ONE and AEW schedules, football-data.org (Premier League; free key), TMDB (Match of the Day; free key), API-Football, and custom JSON/API feeds. Events keep SSS's full normalised record (team names, week, season, round), which is what the matchers read.

- **Providers** (Metadata › Providers) list where schedules come from, with **Test & Preview** for each. Add your own, such as another TheSportsDB league, an ESPN league like `nhl`, a football-data team, or any public JSON schedule, then pick it for a promotion.
- **Start date** limits how far back a promotion is fetched. Without one, a refresh reaches back *Import Past Days* (30). TheSportsDB is rate limited and walks a season round by round, so a TheSportsDB promotion takes a few minutes to refresh; the page shows progress.
- **Logos**: click a promotion's logo to pick another. Candidates come from TheSportsDB's league artwork, ESPN league logos, Wikipedia and Wikimedia Commons (images that fail to load are hidden), or use any https image URL or upload one (stored beside the database, 2 MB max).

## Architecture boundaries

| Concern | Owner |
| --- | --- |
| Calendar and event identity | Replayarr, with schedule sources ported from SSS |
| Release matching rules | Ported from SSS into Replayarr |
| Wanted events, download decisions and job history | Replayarr |
| Actual transfer | qBittorrent / SABnzbd |
| File placement and naming | Replayarr importer |
| Playback | Your media server |

See [docs/phase-1.md](docs/phase-1.md) for the data model, API and what comes next.

## License

MIT. See [LICENSE](LICENSE).
