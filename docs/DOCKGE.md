# Running Replayarr in Dockge

Replayarr is published to `ghcr.io/monkfish1337/replayarr` for amd64 and arm64. Each push to a `phase-*` branch publishes that branch's tag, e.g. `phase-1`; merges to `main` publish `latest`. The image is public, so Dockge pulls it without logging in to GitHub.

To check the server can reach it:

```bash
docker exec dockge docker pull ghcr.io/monkfish1337/replayarr:phase-3
```

## Create the stack

1. In Dockge, **+ Compose**, and name the stack `replayarr`.
2. Paste [`docker-compose.yml`](../docker-compose.yml) into the compose editor.
3. In the **.env** editor below it, paste [`.env.example`](../.env.example) and fill in:
   - `REPLAYARR_PASSWORD`: the UI is on your LAN, so the stack will not start without one.
   - `DATA_ROOT`: the host folder that holds both downloads and your media library, mounted at `/data`.
   - `PUID` / `PGID`: the owner of that folder (`id <user>` on the host).
   - Use `REPLAYARR_TAG=phase-3` for the current work (`phase-1` and `phase-2` stay available), and switch to `latest` once it is merged.
4. To reach Prowlarr, qBittorrent and SABnzbd by container name, uncomment the `networks:` block at the bottom of the compose file and set your existing network, e.g. `stremio-stack_stremio-net`.
5. **Deploy**.

Open `http://<server>:4173` and sign in with `REPLAYARR_USERNAME` (default `admin`) and your password. **System › Status** lists anything still to connect.

## Connect services

On the shared network, use container names:

| Setting | Example |
| --- | --- |
| Metadata › Promotions | Follow the promotions you want; the Premier League needs a free football-data.org key and Match of the Day a free TMDB key (Metadata › Settings) |
| Indexers › Prowlarr | `http://prowlarr:9696`; add a second Prowlarr entry for a separate Usenet instance, e.g. `http://prowlarr-usenet:9797` |
| Indexers › Bitmagnet | `http://gluetun:3333` when Bitmagnet shares Gluetun's network, otherwise `http://bitmagnet:3333` |
| Indexers › Easynews | Your Easynews username and password, and a download folder such as `/data/downloads/easynews` |
| Download Clients | `http://qbittorrent:8080`, `http://sabnzbd:8080`. For qBittorrent 5.2 or newer, use its API key (Options › WebUI › API Key) instead of a username and password |
| Settings › Connect › Jellyfin | `http://jellyfin:8096` and an API key from Jellyfin › Dashboard › API Keys |
| Media Management › Library Folder | `/data/media/sports` (a folder under `DATA_ROOT`) |

If qBittorrent or SABnzbd mount your data under a different path, e.g. `/downloads` instead of `/data/downloads`, add a **Remote Path Mapping** (`/downloads` → `/data/downloads`) under Download Clients. Keep downloads and the library under the same `DATA_ROOT` so imports can be hardlinks.

## Updating

The compose file sets `pull_policy: always`. Dockge's **Update** button pulls the newest image for your tag and recreates only this stack. Settings and the database live in the `replayarr_config` volume and are kept.

If `PUID` is not 1000, replace `replayarr_config:/config` with a host folder owned by that user, e.g. `/opt/stacks/replayarr/config:/config`, created before deploying.

## Troubleshooting

**System › Logs** shows what Replayarr is doing: every request to Prowlarr, Bitmagnet, Easynews, qBittorrent, SABnzbd and Jellyfin, each search query and match verdict, downloads and imports. Set **Settings › General › Log Level** to *Debug* while chasing a problem, then back to *Info*. **Download** saves the log as text to share. API keys, passwords and tokens are removed from every line.

The same lines go to the container's output (Dozzle, `docker logs replayarr`) and to rotating files in the config volume: `/config/logs/replayarr.txt`, keeping 3 files of 5 MB.
