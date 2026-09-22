# Replayarr

**Your sports. On replay.**

Replayarr is an early, self-hosted prototype for finding sports event recordings and managing them from request through download and library import. It is a separate project from [SeriousSportSync](https://github.com/Monkfish1337/Serioussportsync): SSS is a sports calendar and streaming add-on; Replayarr is intended to manage a durable local replay library.

> **Prototype status:** This repository currently contains an interactive UI with illustrative data. It makes no indexer requests, starts no downloads, and writes no media files. The request workflow is simulated and stored only in your browser's local storage.

## Try the prototype

Requires Node.js 20 or newer. There are no npm dependencies.

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173). You can request an event, advance the demo search, review candidate titles, select a release, and simulate download/import completion. The reset button in the top bar restores the initial demo state.

```sh
npm test
```

## Product direction

The central record is a **wanted event**, not a search query or a torrent title. An event has a stable identity, promotion, date, teams or show name, and aliases. A request for that event moves through these stages:

```text
Event → Wanted request → Candidate releases → Reviewed selection
      → Download job → Verified import → Library item
```

The prototype deliberately makes the candidate review step visible. Sports titles vary widely across indexers, and an incorrect automated match is worse than an event waiting for review.

### First working milestone

1. Import event identities and aliases from a stable metadata adapter, beginning with SSS.
2. Persist requests and activity in Replayarr's own database.
3. Run measured, deduplicated searches against a configured Prowlarr instance and/or Bitmagnet.
4. Show candidates with the title, source, identity, score, and reasons for the score.
5. Send an approved candidate to one torrent client and one Usenet client.
6. Follow download state, verify the completed file, and import it under a configurable naming pattern.

Automatic grabs, quality upgrades, additional download clients, and media-server notifications come after that loop is reliable.

## Architecture boundaries

| Concern | Owner |
| --- | --- |
| Calendar and sports-specific event matching | SSS initially; extract a shared contract once stable |
| Wanted events, download decisions and job history | Replayarr |
| Search and candidate provenance | Replayarr adapters |
| Actual transfer | Existing torrent/Usenet download clients |
| Completed file placement and naming | Replayarr importer |
| Playback and stream resolution | SSS / media server |

Replayarr should consume a versioned event API or export from SSS rather than share its writable database. That lets both applications evolve independently, and it avoids download state affecting streaming requests.

See [docs/prototype.md](docs/prototype.md) for screen behavior, the proposed data model, and integration milestones.

## License

MIT. See [LICENSE](LICENSE).
