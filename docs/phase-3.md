# Phase 3: the RSS release cache

Until Phase 3, every wanted event was found by searching: about 60 queries per indexer, repeated on a back-off schedule and every 6 hours for upgrades. Phase 3 adds what Sonarr (and Sportarr) do first: read each indexer's newest releases on a timer and match them locally.

## How it works

1. **RSS sync**, every *RSS Sync Interval* minutes (Settings › Indexers, default 15; 0 turns it off). Each Prowlarr with *RSS* on is asked once for its newest releases (a search with an empty query, which Prowlarr answers with every one of its indexers' latest posts, up to 100 each).
2. New releases go into the **release cache** (`release_cache`, migration 6), keyed like candidates (info hash or guid). A release several Prowlarrs post is kept under the highest priority. Releases not seen for **14 days** are removed.
3. Each new release is matched against every **wanted** event and every event in the library still inside its **upgrade window**. A cheap pre-filter skips releases that share no word with the event (three or more characters, so `ufc 331` counts); the rest go through the same matcher, profile and scoring as a search. Matches become candidates marked *From the RSS cache*; the profile then decides whether to grab, exactly as after a search.
4. **Scheduled searches look in the cache first.** When the worker's back-off schedule makes an event due, Replayarr checks the cache (releases seen since the day before the event) and searches the indexers only if it holds no match. The search buttons (automatic, interactive, manual) always search the indexers.

System › Tasks has *RSS Sync* (run it now from there); System › Status shows the cache size; System › Logs (component `search`) has a line per sync: releases fetched, new, and events matched.

## Why only Prowlarr

- **Bitmagnet** is a local database answering a full ~60-query search in under a second, so a cache would not save anything; it is searched as before.
- **Easynews** has no feed of new posts; it is searched as before.

## Not in Phase 3

- Release rules: size limits per quality, must-contain / must-not-contain words, preferred words and groups.
- Configurable upgrade timing (fixed at every 6 hours for a week).
- Early prelims as their own event.
