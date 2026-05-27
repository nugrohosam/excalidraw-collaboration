# Excalidraw Collaboration

A self-hosted Excalidraw stack with live collaboration, scene/image storage, Docker Compose deployment, and an experimental OSS editor for DMS integration.

The core Excalidraw collaboration stack is usable today. The newer OSS/DMS path now supports opening a file through a wrapper, lightweight same-file realtime sync between wrapper users, and explicit Save back to the gateway/DMS.

This repo has one main deployment mode:

- `deploy/`: Docker Compose deployment with HTTPS nginx routing, MongoDB-backed Excalidraw storage, the OSS gateway API, and the OSS editor wrapper.

## Capability Status

Stable today:

- Self-hosted Excalidraw web app.
- Live collaboration using Excalidraw's built-in collaboration flow.
- Scene/image storage through the Excalidraw storage backend.
- Docker Compose deployment with MongoDB and nginx routing.

Experimental OSS/DMS gateway:

- Session token API.
- File metadata and contents API.
- Lightweight realtime sync channel for users editing the same `fileId` in the wrapper.
- Save API with version checks.
- Lock/unlock API.
- Filesystem storage adapter.
- HTTP adapter contract for calling a DMS.
- Editor wrapper at `/editor/`.

Not built yet:

- The OSS wrapper realtime sync is not Excalidraw's official end-to-end encrypted room protocol.
- Remote changes are synced live in memory, but the file is persisted to DMS only when a user clicks Save.
- Multi-user conflict handling is still basic: version checks protect saved files, but simultaneous explicit saves can still require user coordination.

## What Runs

| Service | Purpose |
| --- | --- |
| `app` / `frontend` | Excalidraw web app. |
| `room` | WebSocket server for live collaboration. |
| `storage` | Excalidraw scene/image storage backend backed by MongoDB. |
| `mongodb` | Persistent database for the Excalidraw storage backend. |
| `file-gateway` | OSS gateway API for file sessions, metadata, contents, saves, locks, and DMS adapter calls. |
| `file-editor` | Experimental wrapper that loads an OSS file, syncs same-file editors in realtime, and saves when the user clicks Save. |

## Requirements

- Docker
- Docker Compose v2
- For advanced public deployment: a domain, HTTPS certificate, and nginx on the host

Check Docker:

```bash
docker --version
docker compose version
```

These commands confirm Docker and Compose are installed.

## Run Locally

Use this when you want the full stack, including MongoDB and the OSS file gateway.

1. Create your env file:

```bash
cp .env.example .env
```

What it does:

- Copies the example environment variables to a real `.env` file.
- Keeps your local secrets/config out of the template.

2. Edit the env file:

```bash
nano .env
```

At minimum, change:

```env
APP_HOST=draw.example.com
ROOM_HOST=draw.example.com
STORAGE_BACKEND_HOST=draw.example.com/storage
DB_PASS=change-me-mongodb-password
TOKEN_SECRET=change-me-to-a-long-random-token-secret
HOST_API_KEY=change-me-host-api-key
ALLOWED_ORIGINS=https://draw.example.com
```

For local testing without nginx/domain, you can temporarily use:

```env
APP_HOST=localhost:9013
ROOM_HOST=localhost:9015
STORAGE_BACKEND_HOST=localhost:9014
ALLOWED_ORIGINS=http://localhost:9013,http://localhost:9017
```

Direct local testing uses the editor on `http://localhost:9017` and passes `gateway_url=http://localhost:9016` in the URL. Production uses nginx so the public editor path is `/editor/` on the same domain.

3. Validate the Compose file:

```bash
docker compose --env-file .env -f deploy/compose.yml config
```

What it does:

- Reads `.env`.
- Resolves all `${VARIABLE}` values in `compose.yml`.
- Prints the final Docker Compose config.
- Fails early if required variables are missing.

4. Start the advanced stack:

```bash
docker compose --env-file .env -f deploy/compose.yml up -d --build
```

What it does:

- Builds the local `file-gateway` image from `file-gateway/Dockerfile`.
- Pulls the external Excalidraw, room, storage, and MongoDB images.
- Starts all services in the background.
- Exposes:
  - Excalidraw app on `http://localhost:9013`
  - Excalidraw storage on `http://localhost:9014`
  - Room server on `http://localhost:9015`
  - OSS file gateway on `http://localhost:9016`
  - OSS editor on `http://localhost:9017`

5. Check running containers:

```bash
docker compose --env-file .env -f deploy/compose.yml ps
```

What it does:

- Shows each service status.
- Helps confirm containers are `Up`.

6. View logs:

```bash
docker compose --env-file .env -f deploy/compose.yml logs -f
```

What it does:

- Streams logs from all services.
- Useful when a service exits or nginx cannot reach a backend.

Stop advanced mode:

```bash
docker compose --env-file .env -f deploy/compose.yml down
```

Stop and remove local data volumes only if you intentionally want a clean reset.

## Smoke Test the OSS Gateway

After advanced mode is running, test the gateway directly on port `9016`:

```bash
curl http://localhost:9016/healthz
```

Expected result:

```json
{
  "ok": true
}
```

What it does:

- Confirms the `file-gateway` service is alive.

Check discovery:

```bash
curl http://localhost:9016/oss/discovery
```

What it does:

- Returns the editor URL template used by the OSS editor.

Create an editor session:

```bash
curl -X POST http://localhost:9016/api/files/demo/sessions \
  -H 'Content-Type: application/json' \
  -H 'X-Gateway-Api-Key: change-me-host-api-key' \
  -d '{"user":{"id":"user-1","name":"Demo User"},"permission":"edit","file":{"url":"https://dms.example.com/files/demo.excalidraw","name":"demo.excalidraw"}}'
```

What it does:

- Asks the gateway to create a temporary browser access token for file `demo`.
- Uses `X-Gateway-Api-Key` so only your host app/DMS can mint sessions.
- Signs the DMS file URL/name into the temporary token.
- Returns an `editorUrl` and `accessToken`.

For local testing, open the returned `editorUrl` through the direct editor service:

```text
http://localhost:9017/?file_id=demo&access_token=PASTE_ACCESS_TOKEN_HERE&gateway_url=http://localhost:9016
```

What it does:

- Loads the drawing through `/api/oss/files/demo/contents`.
- Lets users with the same `file_id` draw together through the OSS realtime channel.
- Shows remote cursor labels for other connected users.
- Saves back through `/api/oss/files/demo/contents` only when the user clicks Save.

Use the returned `accessToken` to check file info manually:

```bash
curl 'http://localhost:9016/api/oss/files/demo?access_token=PASTE_ACCESS_TOKEN_HERE'
```

What it does:

- Confirms the token can access file metadata.
- Creates a blank `.excalidraw` file automatically when using filesystem storage.

## Test Two OSS Editor Users

Create two sessions for the same `fileId`:

```bash
TOKEN1=$(curl -s -X POST http://localhost:9016/api/files/demo/sessions \
  -H 'Content-Type: application/json' \
  -H 'X-Gateway-Api-Key: change-me-host-api-key' \
  -d '{"user":{"id":"user-1","name":"User One"},"permission":"edit","file":{"url":"https://dms.example.com/files/demo.excalidraw","name":"demo.excalidraw"}}' | jq -r .accessToken)

TOKEN2=$(curl -s -X POST http://localhost:9016/api/files/demo/sessions \
  -H 'Content-Type: application/json' \
  -H 'X-Gateway-Api-Key: change-me-host-api-key' \
  -d '{"user":{"id":"user-2","name":"User Two"},"permission":"edit","file":{"url":"https://dms.example.com/files/demo.excalidraw","name":"demo.excalidraw"}}' | jq -r .accessToken)

echo "User 1: http://localhost:9017/?file_id=demo&access_token=$TOKEN1&gateway_url=http://localhost:9016"
echo "User 2: http://localhost:9017/?file_id=demo&access_token=$TOKEN2&gateway_url=http://localhost:9016"
```

Open each URL in a different browser profile or private window.

Expected behavior:

- Both users show as online.
- Scene changes sync between users in memory.
- Remote cursor labels are visible.
- The DMS/file storage is updated only when a user clicks **Save**.

## Prepare DMS Integration

The gateway can either store files locally or call your DMS. This prepares the backend side of the integration.

Local filesystem mode:

```env
STORAGE_ADAPTER=filesystem
```

In filesystem mode, drawings are stored in the Docker named volume `file-data`.

DMS HTTP mode:

```env
STORAGE_ADAPTER=http
HOST_STORAGE_BASE_URL=https://dms.example.com/oss
HOST_STORAGE_API_KEY=change-me-dms-api-key
```

When `STORAGE_ADAPTER=http`, the gateway calls your DMS:

- `GET /files/:fileId`
- `GET /files/:fileId/contents`
- `PUT /files/:fileId/contents`
- `POST /files/:fileId/lock`
- `POST /files/:fileId/unlock`

For every DMS call, the gateway forwards:

- `Authorization: Bearer {HOST_STORAGE_API_KEY}`
- `X-User-Id`
- `X-User-Name`
- `X-User-Permission`
- `X-File-Url`
- `X-File-Name`

The full DMS API contract is in [docs/oss-api.md](./docs/oss-api.md).

Important: setting `STORAGE_ADAPTER=http` makes the OSS gateway call your DMS when the wrapper loads or saves the file. Realtime edits are shared through the gateway's in-memory OSS socket channel; persistence still happens only on explicit Save.

## Configure Nginx for Production

Use [deploy/nginx.conf](./deploy/nginx.conf) as the nginx server block.

The config uses `server_name _;`, so it can catch whichever domain points at this server. Keep the real public domain in `.env` with `APP_HOST`, `ROOM_HOST`, `STORAGE_BACKEND_HOST`, and `ALLOWED_ORIGINS`.

Only the certificate paths in the nginx file need to match the certificate created by Certbot:

```nginx
ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
```

It routes:

- `/` to Excalidraw app on `127.0.0.1:9013`
- `/storage/` to Excalidraw storage on `127.0.0.1:9014`
- `/socket.io/` to room server on `127.0.0.1:9015`
- `/oss/discovery`, `/api/files/`, `/api/oss/`, and `/oss-socket.io/` to file gateway on `127.0.0.1:9016`

After placing the nginx config, test and reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

What it does:

- `nginx -t` checks config syntax.
- `systemctl reload nginx` reloads nginx without stopping active connections.

## Deploy Checklist

Before deploying:

```bash
cp .env.example .env
nano .env
docker compose --env-file .env -f deploy/compose.yml config
docker compose --env-file .env -f deploy/compose.yml up -d --build
docker compose --env-file .env -f deploy/compose.yml ps
```

For production, update at least:

- `APP_HOST`
- `ROOM_HOST`
- `STORAGE_BACKEND_HOST`
- `ALLOWED_ORIGINS`
- `DB_PASS`
- `TOKEN_SECRET`
- `HOST_API_KEY`
- `HOST_STORAGE_BASE_URL`
- `HOST_STORAGE_API_KEY`

## Important Notes

- Browser crypto APIs require HTTPS in production. Localhost is allowed by browsers, but public HTTP domains can fail.
- `TOKEN_SECRET`, `HOST_API_KEY`, `DB_PASS`, and `HOST_STORAGE_API_KEY` must be changed before production use.
- The OSS editor syncs active users with the same `file_id` through an in-memory realtime channel. A user must still click Save to persist the current drawing to the gateway/DMS.
- The `deploy/` stack is the path for DMS integration.

## Docs

- [OSS API Documentation](./docs/oss-api.md)
- [Product Requirements Document](./docs/prd.md)
- [Technical Design](./docs/technical-design.md)
