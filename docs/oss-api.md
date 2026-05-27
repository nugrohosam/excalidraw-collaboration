# OSS API Documentation

This document describes the OSS file gateway API used to connect Excalidraw with a DMS.

The gateway has two jobs:

- Let a trusted host app or DMS create short-lived editor sessions.
- Load and save `.excalidraw` files through either local filesystem storage or your DMS.
- Relay lightweight same-file realtime edits and cursor presence for the OSS editor wrapper.

## Base URLs

Local direct gateway:

```text
http://localhost:9016
```

Production through nginx:

```text
https://draw.example.com
```

## Authentication Model

There are two different secrets.

### Host API Key

Used by your DMS or host app to create editor sessions.

Environment variable:

```env
HOST_API_KEY=change-me-host-api-key
```

Send it as either:

```http
X-Gateway-Api-Key: change-me-host-api-key
```

or:

```http
Authorization: Bearer change-me-host-api-key
```

### Browser Access Token

Created by the gateway after a session request. The browser uses this token to read/write one file.

The token is short-lived and signed with:

```env
TOKEN_SECRET=change-me-to-a-long-random-token-secret
```

Use it as either:

```http
Authorization: Bearer {accessToken}
```

or:

```text
?access_token={accessToken}
```

## Gateway Endpoints

### Health Check

```http
GET /healthz
```

Example:

```bash
curl http://localhost:9016/healthz
```

Response:

```json
{
  "ok": true
}
```

### Discovery

```http
GET /oss/discovery
```

Example:

```bash
curl http://localhost:9016/oss/discovery
```

Response:

```json
{
  "product": "Excalidraw Collaboration Gateway",
  "version": "0.1.0",
  "actions": [
    {
      "ext": "excalidraw",
      "name": "edit",
      "urlsrc": "https://draw.example.com/editor/?file_id={file_id}&access_token={access_token}"
    },
    {
      "ext": "excalidraw",
      "name": "view",
      "urlsrc": "https://draw.example.com/editor/?file_id={file_id}&access_token={access_token}&readonly=1"
    }
  ]
}
```

### Create Editor Session

```http
POST /api/files/{fileId}/sessions
```

Creates a short-lived token for opening one file.

Headers:

```http
Content-Type: application/json
X-Gateway-Api-Key: {HOST_API_KEY}
```

Request:

```json
{
  "user": {
    "id": "user-2",
    "name": "User Two"
  },
  "permission": "edit",
  "file": {
    "url": "https://dms.example.com/files/demo.excalidraw",
    "name": "demo.excalidraw"
  },
  "ttlSeconds": 3600
}
```

`permission` can be:

- `view`
- `edit`

`file.url` and `file.name` are optional for local filesystem mode, but recommended for DMS mode.

Flat aliases are also supported:

```json
{
  "user": {
    "id": "user-2",
    "name": "User Two"
  },
  "permission": "edit",
  "fileUrl": "https://dms.example.com/files/demo.excalidraw",
  "fileName": "demo.excalidraw"
}
```

Example:

```bash
curl -X POST http://localhost:9016/api/files/demo/sessions \
  -H 'Content-Type: application/json' \
  -H 'X-Gateway-Api-Key: change-me-host-api-key' \
  -d '{"user":{"id":"user-2","name":"User Two"},"permission":"edit","file":{"url":"https://dms.example.com/files/demo.excalidraw","name":"demo.excalidraw"}}'
```

Response:

```json
{
  "fileId": "demo",
  "accessToken": "signed-token",
  "expiresAt": "2026-05-27T10:30:00.000Z",
  "editorUrl": "https://draw.example.com/editor/?file_id=demo&access_token=signed-token"
}
```

### Get File Info

```http
GET /api/oss/files/{fileId}
```

Headers:

```http
Authorization: Bearer {accessToken}
```

Example:

```bash
curl 'http://localhost:9016/api/oss/files/demo?access_token=PASTE_ACCESS_TOKEN_HERE'
```

Response:

```json
{
  "BaseFileName": "demo.excalidraw",
  "OwnerId": "filesystem",
  "Size": 38122,
  "UserId": "user-2",
  "UserFriendlyName": "User Two",
  "UserCanWrite": true,
  "Version": "42",
  "SupportsLocks": true,
  "SupportsUpdate": true
}
```

### Get File Contents

```http
GET /api/oss/files/{fileId}/contents
```

Headers:

```http
Authorization: Bearer {accessToken}
```

Response:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [],
  "appState": {
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
```

### Save File Contents

```http
PUT /api/oss/files/{fileId}/contents
```

Headers:

```http
Authorization: Bearer {accessToken}
Content-Type: application/json
X-File-Version: {currentVersion}
X-Lock: {lockId}
```

`X-File-Version` is optional. If provided, the gateway rejects stale saves.

`X-Lock` is required only when a lock exists.

Example:

```bash
curl -X PUT 'http://localhost:9016/api/oss/files/demo/contents?access_token=PASTE_ACCESS_TOKEN_HERE' \
  -H 'Content-Type: application/json' \
  -H 'X-File-Version: 42' \
  -d '{"type":"excalidraw","version":2,"source":"dms","elements":[],"appState":{},"files":{}}'
```

Response:

```json
{
  "version": "43",
  "savedAt": "2026-05-27T10:35:00.000Z"
}
```

## OSS Realtime Channel

The editor wrapper uses a Socket.IO channel for lightweight same-file collaboration.

Endpoint:

```text
/oss-socket.io
```

Client auth payload:

```json
{
  "fileId": "demo",
  "accessToken": "signed-token"
}
```

Events:

| Event | Direction | Purpose |
| --- | --- | --- |
| `presence:update` | server to client | Lists users currently connected to the same `fileId`. |
| `scene:sync` | server to client | Sends the latest in-memory scene to a newly connected user. |
| `scene:update` | both directions | Broadcasts the current scene to other users in the same `fileId`. |
| `pointer:update` | both directions | Broadcasts normalized pointer position for remote cursor UI. |
| `pointer:leave` | server to client | Removes a disconnected user's remote cursor. |

Important behavior:

- Realtime scene state is held in gateway memory.
- Realtime updates are not persisted to the DMS automatically.
- The DMS file changes only when a user calls `PUT /api/oss/files/{fileId}/contents`, normally by clicking Save in the wrapper.
- The channel is intended as an MVP sync layer, not Excalidraw's official encrypted collaboration protocol.
- Pointer coordinates are UI-only, normalized to the editor viewport, and are not saved.

### Lock File

```http
POST /api/oss/files/{fileId}/lock
```

Headers:

```http
Authorization: Bearer {accessToken}
X-Lock: {lockId}
```

Example:

```bash
curl -X POST 'http://localhost:9016/api/oss/files/demo/lock?access_token=PASTE_ACCESS_TOKEN_HERE' \
  -H 'X-Lock: lock-123'
```

Response:

```json
{
  "fileId": "demo",
  "lockId": "lock-123",
  "ownerUserId": "user-2",
  "ownerUserName": "User Two",
  "expiresAt": "2026-05-27T11:00:00.000Z",
  "refreshedAt": "2026-05-27T10:30:00.000Z"
}
```

### Unlock File

```http
POST /api/oss/files/{fileId}/unlock
```

Headers:

```http
Authorization: Bearer {accessToken}
X-Lock: {lockId}
```

Example:

```bash
curl -X POST 'http://localhost:9016/api/oss/files/demo/unlock?access_token=PASTE_ACCESS_TOKEN_HERE' \
  -H 'X-Lock: lock-123'
```

Response:

```json
{
  "unlocked": true
}
```

## DMS Adapter Contract

When the gateway runs with:

```env
STORAGE_ADAPTER=http
HOST_STORAGE_BASE_URL=https://dms.example.com/oss
HOST_STORAGE_API_KEY=change-me-dms-api-key
```

the gateway calls your DMS at:

```text
https://dms.example.com/oss
```

### Headers Sent to DMS

Every DMS call can receive:

```http
Authorization: Bearer {HOST_STORAGE_API_KEY}
X-User-Id: user-2
X-User-Name: User Two
X-User-Permission: edit
X-File-Url: https://dms.example.com/files/demo.excalidraw
X-File-Name: demo.excalidraw
```

These headers come from the signed browser access token created by
`POST /api/files/{fileId}/sessions`. The gateway must preserve the full token
claims when forwarding any request to DMS:

- `userId`
- `userName`
- `permission`
- `fileUrl`
- `fileName`

This applies to read/open, save, lock, and unlock. Save handling must not reduce
the forwarded claims to only save options such as `expectedVersion`, `lockId`,
`userId`, and `userName`; otherwise `X-User-Permission`, `X-File-Url`, and
`X-File-Name` can be lost.

Save requests can also receive:

```http
X-File-Version: 42
X-Lock: lock-123
```

Lock requests receive:

```http
X-Lock: lock-123
```

### DMS: Get Metadata

```http
GET /files/{fileId}
```

Response:

```json
{
  "fileName": "demo.excalidraw",
  "size": 38122,
  "version": "42",
  "updatedAt": "2026-05-27T10:02:11.000Z",
  "updatedBy": {
    "id": "user-1",
    "name": "User One"
  }
}
```

### DMS: Get Contents

```http
GET /files/{fileId}/contents
```

Response body must be raw `.excalidraw` JSON.

### DMS: Save Contents

```http
PUT /files/{fileId}/contents
```

Request body is raw `.excalidraw` JSON.

Expected authorization/context headers:

```http
Authorization: Bearer {HOST_STORAGE_API_KEY}
X-User-Id: user-2
X-User-Name: User Two
X-User-Permission: edit
X-File-Url: https://dms.example.com/files/demo.excalidraw
X-File-Name: demo.excalidraw
X-File-Version: 42
X-Lock: lock-123
```

`X-File-Version` and `X-Lock` are conditional, but `X-User-Permission` should
be present whenever the DMS enforces save authorization.

Response:

```json
{
  "version": "43",
  "savedAt": "2026-05-27T10:35:00.000Z"
}
```

### DMS: Lock

```http
POST /files/{fileId}/lock
```

Request:

```json
{
  "lockId": "lock-123",
  "ttlSeconds": 1800
}
```

### DMS: Unlock

```http
POST /files/{fileId}/unlock
```

Request:

```json
{
  "lockId": "lock-123"
}
```

## Status Codes

The gateway uses:

| Status | Meaning |
| --- | --- |
| `200` | Request succeeded. |
| `201` | Session created. |
| `400` | Invalid request. |
| `401` | Missing/invalid token or API key. |
| `403` | Token is valid but not allowed for this action. |
| `404` | Endpoint not found. |
| `409` | Version conflict or lock conflict. |
| `413` | Request body too large. |
| `502` | DMS returned an unsupported error or invalid response. |

## File ID Rules

`fileId` is used in URLs and must match:

```text
A-Z a-z 0-9 _ . -
```

Examples:

```text
demo
drawing-123
folder.file-001
```

Do not use slashes in `fileId`. Put full DMS paths or URLs in `file.url` instead.
