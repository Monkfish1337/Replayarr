# Phase 2: quality profiles, automatic grabs and upgrades

Phase 1 stopped at review: every release was chosen by hand. Phase 2 lets Replayarr finish the loop on its own, as Sonarr does, while keeping the evidence for each decision.

## Quality profiles

**Settings › Profiles.** A profile has:

| Field | Meaning |
| --- | --- |
| Qualities | Accepted resolutions: 2160p, 1080p, 720p, 576p, 480p, and *Unknown* for releases that do not state one. Others are rejected with `profile: 720p not wanted by HD-1080p`, and can still be grabbed anyway. |
| Upgrade Until (cutoff) | Once the library copy is this good, stop looking for better. |
| Upgrades | Whether an event below the cutoff keeps being searched after import. |
| Automatic Grab | Whether an automatic search sends the best match on its own. |
| Minimum Score | The score (shown in Interactive Search) an automatic grab needs. Lower matches wait in *Wanted › Needs Review*. |

Each promotion picks a profile under **Metadata › Promotions**, or uses the first one. A new install has one profile, *Any*: every quality, cutoff 1080p, upgrades on, auto-grab at score 60.

Profiles are stored with the settings (`profiles`); a promotion's choice is `promotion_meta.profile_id` (migration 5).

## Automatic grabs

An automatic search (the worker, **Search All**, or an event's search button) that finds matches picks the best one the profile allows: highest score, at least the minimum, with a download client to send it to. The activity log says what was grabbed and why (`grabbed … automatically (score 82; Any needs 60)`). **Interactive Search never grabs.**

When a download fails or disappears from its client, that release is marked `download: failed (…)` and not offered again. An auto-grab profile then sends the next best match, or searches again in 30 minutes if there is none.

## Upgrades

After an import below the profile's cutoff (with upgrades on), the event keeps its request in *ready* and is searched again **every 6 hours until a week after the event**. A match that is an allowed, better quality (and meets the minimum score) is grabbed; the library copy stays until the new one has imported, then the old file and its .nfo and thumbnail are removed. If the upgrade fails to download or import, the event stays ready with its old copy.

**Wanted › Cutoff Unmet** lists events below their cutoff and when they are next searched. The search buttons now work on events in the library: automatic search looks for an upgrade, interactive search lists what is available.

## Request lifecycle additions

```text
ready ─▶ downloading ─▶ importing ─▶ ready      (an upgrade)
            │                 │
            └──▶ ready ◀──────┘                 (the upgrade failed; the library copy stays)
```

## Not in Phase 2

- An RSS release cache (poll indexers' recent releases and match locally, as Sportarr does) instead of searching each event.
- Size limits per quality, and preferred words or release groups.
- Configurable upgrade window and interval (fixed at 6 hours for 7 days).
