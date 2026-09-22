# Running Replayarr in Dockge

Replayarr is published to `ghcr.io/monkfish1337/replayarr` for amd64 and arm64. Each push to a `phase-*` branch publishes that branch's tag, e.g. `phase-1`; merges to `main` publish `latest`. The repository is private, so the image is too, and Docker must be logged in to GHCR before it can pull.

## 1. Create a GitHub token for pulling images

GHCR only accepts **classic** personal access tokens; fine-grained tokens do not work with it.

1. Open [github.com/settings/tokens/new?scopes=read:packages&description=homelab-ghcr-pull](https://github.com/settings/tokens/new?scopes=read:packages&description=homelab-ghcr-pull). That is *Settings › Developer settings › Personal access tokens › Tokens (classic) › Generate new token (classic)* with the fields pre-filled.
2. Leave only **`read:packages`** ticked. The server only pulls; it needs nothing else.
3. Choose an expiration. When it expires, pulls start failing with `denied`/`unauthorized`; create a new token and repeat step 2 below.
4. **Generate token** and copy it (`ghp_…`). GitHub shows it only once.

If you already logged in for the private SSS scraper image with a classic `read:packages` token, that token also works here: it covers every package your account can read. Skip to step 3 to check.

## 2. Log in where Dockge can use it

Dockge runs `docker compose` with the Docker client *inside the Dockge container*, and Docker stores registry logins with the client, not the daemon. A `docker login` on the host is therefore invisible to Dockge unless Dockge can see the host's login file.

**Recommended: share the host login with Dockge.** On the server:

```bash
# Log in on the host as root; this writes /root/.docker/config.json.
read -rsp 'GitHub token: ' CR_PAT && echo
printf '%s' "$CR_PAT" | sudo docker login ghcr.io -u Monkfish1337 --password-stdin
unset CR_PAT
```

Then add one line to the `volumes:` of **Dockge's own** compose file (usually `/opt/dockge/compose.yaml`) and restart Dockge:

```yaml
      - /root/.docker:/root/.docker:ro
```

The login now survives Dockge updates, and the same token serves host `docker` commands.

**Quick alternative (no Dockge change):** log in inside the running Dockge container. This is lost whenever the Dockge container is recreated, e.g. when you update Dockge:

```bash
docker exec -it dockge docker login ghcr.io -u Monkfish1337
# Paste the token at the Password prompt.
```

Never put the token in the Replayarr stack's `.env`.

## 3. Check the pull works

```bash
docker exec dockge docker pull ghcr.io/monkfish1337/replayarr:phase-1
```

`denied` or `unauthorized` means Dockge is not seeing a valid login: repeat step 2, and check the token is classic with `read:packages`. `manifest unknown` means the tag does not exist; check the tag name.

## 4. Create the stack

1. In Dockge, **+ Compose**, and name the stack `replayarr`.
2. Paste [`docker-compose.yml`](../docker-compose.yml) into the compose editor.
3. In the **.env** editor below it, paste [`.env.example`](../.env.example) and fill in:
   - `REPLAYARR_PASSWORD`: the UI is on your LAN, so the stack will not start without one.
   - `DATA_ROOT`: the host folder that holds both downloads and your media library, mounted at `/data`.
   - `PUID` / `PGID`: the owner of that folder (`id <user>` on the host).
   - Keep `REPLAYARR_TAG=phase-1` until Phase 1 is merged, then switch to `latest`.
4. To reach Prowlarr, qBittorrent and SABnzbd by container name, uncomment the `networks:` block at the bottom of the compose file and set your existing network, e.g. `stremio-stack_stremio-net`.
5. **Deploy**.

Open `http://<server>:4173` and sign in with `REPLAYARR_USERNAME` (default `admin`) and your password. **System › Status** lists anything still to connect.

## 5. Connect services

On the shared network, use container names:

| Setting | Example |
| --- | --- |
| Metadata Source › Install URL | Your SSS addon URL from the SSS account page. `http://serioussportsync:7000/u/…/manifest.json` if SSS is on the same network |
| Indexers › Prowlarr URL | `http://gluetun:9696` if Prowlarr runs behind Gluetun, otherwise `http://prowlarr:9696` |
| Download Clients | `http://qbittorrent:8080`, `http://sabnzbd:8080` |
| Media Management › Library Folder | `/data/media/sports` (a folder under `DATA_ROOT`) |

If qBittorrent or SABnzbd mount your data under a different path, e.g. `/downloads` instead of `/data/downloads`, add a **Remote Path Mapping** (`/downloads` → `/data/downloads`) under Download Clients. Keep downloads and the library under the same `DATA_ROOT` so imports can be hardlinks.

## Updating

The compose file sets `pull_policy: always`. Dockge's **Update** button pulls the newest image for your tag and recreates only this stack. Settings and the database live in the `replayarr_config` volume and are kept.

If `PUID` is not 1000, replace `replayarr_config:/config` with a host folder owned by that user, e.g. `/opt/stacks/replayarr/config:/config`, created before deploying.
