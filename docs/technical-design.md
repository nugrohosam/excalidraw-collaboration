# Technical Design: Excalidraw File Collaboration Gateway MVP

## 1. Scope

This design implements the first real slice of the PRD:

- OSS discovery endpoint.
- Host-created editor sessions.
- Signed access tokens.
- Check file info endpoint.
- Get file contents endpoint.
- Put file contents endpoint.
- Basic lock and unlock endpoints.
- Filesystem storage adapter.
- HTTP DMS storage adapter.
- Lightweight same-file realtime sync and cursor presence.
- Docker Compose and nginx wiring.

The MVP adds a small OSS editor wrapper. It creates the backend contract, opens files from storage/DMS, shares in-progress changes between users on the same `fileId`, and persists the document only when a user clicks Save.

For the API contract used by the DMS and host application, see [OSS API Documentation](./oss-api.md).

## 2. Stack

- Runtime: Node.js 22.
- HTTP server: built-in `node:http`.
- Realtime server: Socket.IO.
- Storage: local filesystem adapter or HTTP DMS adapter.
- Token signing: HMAC SHA-256 using `TOKEN_SECRET`.
- Metadata: sidecar JSON files under the configured storage directory.

Socket.IO is the only runtime dependency beyond the Node.js standard library.

## 3. Service Layout

```text
file-gateway/
  Dockerfile
  package.json
  src/
    server.js
```

## 4. Environment Variables

- `PORT`: Gateway listen port. Default: `8090`.
- `APP_PUBLIC_URL`: Public Excalidraw URL. Example: `https://draw.example.com`.
- `EDITOR_OPEN_PATH`: Editor URL path. Default: `/editor/`.
- `GATEWAY_PUBLIC_URL`: Public gateway URL. Example: `https://draw.example.com`.
- `HOST_API_KEY`: Optional shared secret required to create editor sessions.
- `TOKEN_SECRET`: Required in production. Used to sign access tokens.
- `TOKEN_TTL_SECONDS`: Default access token lifetime. Default: `3600`.
- `STORAGE_ADAPTER`: `filesystem` or `http`.
- `FILESYSTEM_STORAGE_PATH`: Directory for `.excalidraw` files and metadata. Default: `/data/files`.
- `HOST_STORAGE_BASE_URL`: DMS file API base URL when `STORAGE_ADAPTER=http`.
- `HOST_STORAGE_API_KEY`: Optional DMS API key sent as `Authorization: Bearer ...`.
- `ALLOWED_ORIGINS`: Comma-separated CORS origins. Use `*` only for local development.
- `MAX_BODY_BYTES`: Maximum upload body size. Default: `10485760`.
- `LOCK_TTL_SECONDS`: Lock lifetime. Default: `1800`.

## 5. Filesystem Adapter

The filesystem adapter stores files like this:

```text
/data/files/
  drawing-123.excalidraw
  .meta/
    drawing-123.json
    drawing-123.lock.json
```

File IDs are constrained to safe characters:

```text
A-Z a-z 0-9 _ . -
```

This prevents path traversal and keeps URLs simple.

## 6. HTTP DMS Adapter

Set these variables to let the gateway communicate with a DMS:

```env
STORAGE_ADAPTER=http
HOST_STORAGE_BASE_URL=https://dms.example.com/oss
HOST_STORAGE_API_KEY=change-me-dms-api-key
```

The gateway calls the DMS with:

- `Authorization: Bearer {HOST_STORAGE_API_KEY}` when configured.
- `X-User-Id`
- `X-User-Name`
- `X-User-Permission`
- `X-File-Url`
- `X-File-Name`

`X-File-Url` and `X-File-Name` come from the session creation request:

```json
{
  "file": {
    "url": "https://dms.example.com/files/drawing-123.excalidraw",
    "name": "drawing-123.excalidraw"
  }
}
```

The flat aliases `fileUrl` and `fileName` are also accepted.

### Required DMS Endpoints

`GET /files/:fileId`

Returns metadata:

```json
{
  "fileName": "diagram.excalidraw",
  "size": 38122,
  "version": "42",
  "updatedAt": "2026-05-27T10:02:11Z",
  "updatedBy": {
    "id": "user-123",
    "name": "Nugroho"
  }
}
```

`GET /files/:fileId/contents`

Returns raw `.excalidraw` JSON.

`PUT /files/:fileId/contents`

Receives raw `.excalidraw` JSON. The gateway forwards:

- `X-File-Version` when the editor has a known version.
- `X-Lock` when a lock exists.

Returns:

```json
{
  "version": "43",
  "savedAt": "2026-05-27T10:05:00Z"
}
```

### Optional DMS Lock Endpoints

`POST /files/:fileId/lock`

Request body:

```json
{
  "lockId": "lock-123",
  "ttlSeconds": 1800
}
```

`POST /files/:fileId/unlock`

Request body:

```json
{
  "lockId": "lock-123"
}
```

The DMS should return `409 Conflict` when the file version or lock does not match.

## 7. Token Format

The gateway uses compact signed tokens:

```text
base64url(json-payload).base64url(hmac-sha256(payload))
```

Payload:

```json
{
  "fileId": "drawing-123",
  "userId": "user-123",
  "userName": "Nugroho",
  "permission": "edit",
  "fileUrl": "https://dms.example.com/files/drawing-123.excalidraw",
  "fileName": "drawing-123.excalidraw",
  "exp": 1780000000,
  "nonce": "random-id"
}
```

Permissions:

- `view`
- `edit`

The token is intentionally not encrypted. It must not contain secrets beyond short-lived session claims.

## 8. Endpoints

### `GET /healthz`

Returns service health.

### `GET /oss/discovery`

Returns supported file actions and editor URL templates.

### `POST /api/files/:fileId/sessions`

Creates a short-lived editor session.

If `HOST_API_KEY` is configured, the request must include one of:

- `Authorization: Bearer {HOST_API_KEY}`
- `X-Gateway-Api-Key: {HOST_API_KEY}`

Request:

```json
{
  "user": {
    "id": "user-123",
    "name": "Nugroho"
  },
  "permission": "edit",
  "file": {
    "url": "https://dms.example.com/files/drawing-123.excalidraw",
    "name": "drawing-123.excalidraw"
  },
  "ttlSeconds": 3600
}
```

Response includes `accessToken` and `editorUrl`.

### `GET /api/oss/files/:fileId`

Returns OSS file info.

Requires `Authorization: Bearer {token}` or `access_token` query parameter.

### `GET /api/oss/files/:fileId/contents`

Returns raw `.excalidraw` JSON.

Requires a valid token.

### `PUT /api/oss/files/:fileId/contents`

Saves raw `.excalidraw` JSON.

Requires:

- Valid token.
- `edit` permission.
- Matching `X-File-Version` when provided.
- Matching `X-Lock` when a lock exists.

### `POST /api/oss/files/:fileId/lock`

Creates or refreshes a lock.

### `POST /api/oss/files/:fileId/unlock`

Releases a matching lock.

## 9. Versioning

The filesystem adapter stores a monotonically increasing numeric version in metadata.

Conflict behavior:

- If `X-File-Version` is present and does not match current version, return `409 Conflict`.
- If the header is absent, allow save. This keeps early integrations easier.

## 10. Nginx Routes

Route these paths to `file-gateway`:

- `/healthz`
- `/oss/discovery`
- `/api/files/`
- `/api/oss/`
- `/oss-socket.io/`

Existing routes remain:

- `/socket.io/` to room server.
- `/storage/` to Excalidraw storage backend.
- `/` to Excalidraw app.

## 11. Editor Wrapper

The OSS editor wrapper:

- Reads `file_id` and `access_token` from the URL.
- Calls `GET /api/oss/files/:fileId`.
- Calls `GET /api/oss/files/:fileId/contents`.
- Initializes Excalidraw with that scene.
- Connects to `/oss-socket.io` for lightweight same-file realtime scene sync.
- Broadcasts pointer positions for remote cursor labels.
- Saves with `PUT /api/oss/files/:fileId/contents` when the user clicks Save.
- Uses `UserCanWrite` to set read-only behavior.

Future work:

- Replace or harden the MVP realtime sync with a CRDT or Excalidraw-compatible encrypted room protocol.
- Improve save/version UX when multiple editors save concurrently.
