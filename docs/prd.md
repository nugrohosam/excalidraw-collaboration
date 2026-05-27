# Product Requirements Document: Excalidraw File Collaboration Gateway

## 1. Summary

Build a simple file collaboration gateway for Excalidraw that works like a lightweight Collabora/WOPI-style integration. A host application should be able to open a drawing file in an embedded Excalidraw editor, collaborate live with other users, and save the final `.excalidraw` document back to the host storage through a small HTTP protocol.

The current repository already runs:

- Excalidraw frontend
- Excalidraw room server for live collaboration
- Excalidraw storage backend
- MongoDB for scene storage in advanced mode
- Nginx reverse proxy for HTTPS

This project adds the missing file protocol layer so Excalidraw can be launched against real files instead of only ad hoc collaboration rooms.

## 2. Problem

Current self-hosted Excalidraw collaboration is useful for shared drawing sessions, but it does not provide a simple file lifecycle:

- No standard way for another app to ask Excalidraw to open a specific file.
- No host-facing check for file metadata, permissions, or user identity.
- No explicit save flow back into the host application.
- No simple lock/version contract to prevent accidental overwrite.
- No discovery endpoint that tells a host application how to launch the editor.

Collabora solves this class of problem with WOPI. This project does not need full WOPI compatibility at first, but it should copy the core shape: discovery, check file info, get file, put file, locks, access tokens, and an editor URL.

## 3. Goals

- Let a host app open an `.excalidraw` file in the browser using a generated editor URL.
- Support live collaboration for the same file.
- Save changes back to the host storage through a protocol endpoint.
- Support basic permissions: read-only and editable.
- Support optimistic concurrency with version checks.
- Support optional file locks for safer multi-user editing.
- Keep deployment simple with Docker Compose and nginx.
- Keep the first production version small enough to implement and operate.

## 4. Non-Goals

- Full Microsoft WOPI certification.
- Editing arbitrary Office formats.
- Replacing Collabora or OnlyOffice.
- Building a full document management system.
- Complex user management, SSO, or RBAC in the first version.
- Offline-first sync across devices.

## 5. Target Users

- Developers who want to embed Excalidraw as a document editor inside their own system.
- Teams that already store files in an app, LMS, CMS, cloud drive, or internal portal.
- Self-hosters who want real collaborative `.excalidraw` files without Firebase.

## 6. User Stories

- As a host application, I can ask the gateway where the Excalidraw editor is located.
- As a host application, I can create an editor URL for a specific file and user.
- As a user, I can open a drawing from the host app and immediately edit it in Excalidraw.
- As a user, I can share the same file session with collaborators.
- As a user with read-only permission, I can view but not save the file.
- As a host application, I receive saved file content and can store it in my own backend.
- As a host application, I can reject stale saves when the file version has changed.
- As an operator, I can deploy the whole stack with Docker Compose and HTTPS.

## 7. Proposed Architecture

### 7.1 Services

1. `app`
   - Existing Excalidraw frontend image.
   - May need a fork/configuration update to support file-open and file-save callbacks.

2. `room`
   - Existing `excalidraw-room` websocket service.
   - Used for live collaboration.

3. `storage`
   - Existing Excalidraw scene storage backend.
   - Used for scene/blob persistence if still needed by the frontend.

4. `file-gateway`
   - New service.
   - Provides OSS file protocol endpoints.
   - Validates access tokens.
   - Fetches/saves files from the configured host storage adapter.
   - Creates editor sessions and maps files to Excalidraw room IDs.

5. `host-storage`
   - Not owned by this project in production.
   - For local development, provide a simple filesystem adapter.

### 7.2 Request Flow

1. Host app calls `POST /api/files/{fileId}/sessions`.
2. Gateway validates the host request and creates a short-lived access token.
3. Gateway returns an editor URL:
   - `https://draw.example.com/editor/?file_id={fileId}&access_token={token}`
4. Browser opens Excalidraw.
5. Excalidraw calls gateway to load file metadata and content.
6. Gateway returns `.excalidraw` JSON and collaboration room details.
7. Users edit together through the room server.
8. Excalidraw saves through gateway.
9. Gateway writes the updated file to host storage if permissions and version checks pass.

## 8. Protocol Requirements

The protocol should be WOPI-inspired, but intentionally smaller.

### 8.1 Discovery

`GET /oss/discovery`

Returns editor capabilities and URL templates.

Example response:

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

### 8.2 Create Session

`POST /api/files/{fileId}/sessions`

Creates an editor session for a specific file.

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

Response:

```json
{
  "fileId": "drawing-123",
  "accessToken": "signed-token",
  "expiresAt": "2026-05-27T10:30:00Z",
  "editorUrl": "https://draw.example.com/editor/?file_id=drawing-123&access_token=signed-token"
}
```

### 8.3 Check File Info

`GET /api/oss/files/{fileId}`

Headers:

- `Authorization: Bearer {accessToken}`

Response:

```json
{
  "BaseFileName": "diagram.excalidraw",
  "OwnerId": "workspace-123",
  "Size": 38122,
  "UserId": "user-123",
  "UserFriendlyName": "Nugroho",
  "UserCanWrite": true,
  "Version": "42",
  "SupportsLocks": true,
  "SupportsUpdate": true
}
```

### 8.4 Get File

`GET /api/oss/files/{fileId}/contents`

Returns the raw `.excalidraw` JSON file.

### 8.5 Put File

`PUT /api/oss/files/{fileId}/contents`

Headers:

- `Authorization: Bearer {accessToken}`
- `X-File-Version: {version}`
- `X-Lock: {lockId}` when locks are enabled

Behavior:

- Reject if token is expired.
- Reject if user lacks write permission.
- Reject if lock exists and does not match.
- Reject if the submitted version is stale.
- Save the new `.excalidraw` JSON.
- Return the new version.

Response:

```json
{
  "version": "43",
  "savedAt": "2026-05-27T10:02:11Z"
}
```

### 8.6 Locks

`POST /api/oss/files/{fileId}/lock`

Creates or refreshes a lock.

`POST /api/oss/files/{fileId}/unlock`

Releases a lock.

Lock TTL should default to 30 minutes and refresh while an editor session is active.

## 9. Data Model

### 9.1 File Session

- `id`
- `fileId`
- `userId`
- `userName`
- `permission`
- `accessTokenHash`
- `expiresAt`
- `createdAt`
- `lastSeenAt`

### 9.2 File Metadata

For the local filesystem adapter:

- `fileId`
- `fileName`
- `path`
- `size`
- `version`
- `updatedAt`
- `updatedBy`

For external host storage, metadata can come from the host API.

### 9.3 Lock

- `fileId`
- `lockId`
- `ownerUserId`
- `expiresAt`
- `createdAt`
- `refreshedAt`

## 10. Security Requirements

- All production traffic must use HTTPS.
- Access tokens must be signed and short-lived.
- Access tokens must include file ID, user ID, permission, expiry, and nonce.
- Gateway must verify token file ID matches requested file ID.
- Read-only tokens must never be allowed to save.
- File paths must not be derived directly from user input.
- Local filesystem adapter must prevent path traversal.
- CORS should allow only configured host origins.
- Request body size must be configurable.
- Logs must not print access tokens.

## 11. Storage Adapter Requirements

The gateway should support adapters behind a common interface:

- `getFileInfo(fileId)`
- `getFileContents(fileId)`
- `putFileContents(fileId, content, expectedVersion)`
- `lockFile(fileId, lockId, owner, ttl)`
- `unlockFile(fileId, lockId)`

Initial adapters:

1. `filesystem`
   - Stores files under a configured directory.
   - Good for local development and simple self-hosting.

2. `http`
   - Calls a host application's API.
   - Good for real integration.
   - Intended for DMS integration where the DMS owns metadata, permissions, versions, and permanent file storage.

Future adapters:

- S3-compatible object storage.
- WebDAV.
- Nextcloud app integration.

## 12. Excalidraw Integration Requirements

The editor must support:

- Opening from `file_id` and `access_token` query parameters.
- Loading file JSON from gateway.
- Joining a deterministic collaboration room for the file session.
- Saving to gateway through `PUT /contents`.
- Displaying read-only mode when token permission is `view`.
- Handling save conflicts with a clear user message.

Implementation options:

1. Fork Excalidraw frontend image and add gateway integration.
2. Build a small wrapper app that embeds Excalidraw and controls load/save.

Recommended first path: use a wrapper app if the current fork exposes enough hooks. Use a fork only if required.

## 13. Deployment Requirements

Update `advanced-nginx/compose.yml` to include:

- `file-gateway`
- gateway env vars
- persistent file storage volume for local adapter

Update nginx to route:

- `/oss/discovery` to gateway
- `/api/oss/` to gateway
- `/api/files/` to gateway
- `/socket.io/` to room
- `/storage/` to existing storage backend
- `/` to Excalidraw app

Required environment variables:

- `APP_HOST`
- `GATEWAY_PUBLIC_URL`
- `APP_PUBLIC_URL`
- `TOKEN_SECRET`
- `TOKEN_TTL_SECONDS`
- `STORAGE_ADAPTER`
- `FILESYSTEM_STORAGE_PATH`
- `HOST_STORAGE_BASE_URL`
- `HOST_STORAGE_API_KEY`
- `ALLOWED_ORIGINS`

## 14. Milestones

### M1: PRD and Technical Design

- Create this PRD.
- Decide whether to implement gateway in Node.js, Go, or another stack.
- Decide whether to use a wrapper app or Excalidraw fork.
- Define exact Docker Compose shape.

### M2: Gateway MVP

- Implement discovery endpoint.
- Implement session creation.
- Implement signed access tokens.
- Implement check file info.
- Implement get contents.
- Implement put contents.
- Implement filesystem storage adapter.
- Add Dockerfile and compose service.

### M3: Editor Open/Save Flow

- Add editor URL flow.
- Load `.excalidraw` file by token.
- Save `.excalidraw` file by token.
- Support read-only mode.
- Add basic conflict handling.

### M4: Live Collaboration Per File

- Map file IDs to collaboration rooms.
- Ensure multiple users opening the same file join the same room.
- Define save behavior during live sessions.
- Add lock refresh while a user is editing.

### M5: Production Hardening

- Add nginx routes.
- Add request size limits.
- Add CORS configuration.
- Add structured logs.
- Add basic metrics or health endpoint.
- Add integration tests.
- Update README with setup instructions.

## 15. Acceptance Criteria

- A host app can fetch discovery info.
- A host app can create an editor session for a file.
- A user can open an editor URL and see the file content.
- Two users opening the same file can collaborate live.
- A user with edit permission can save changes.
- A user with view permission cannot save changes.
- A stale save is rejected with a conflict response.
- A file lock prevents conflicting writers when enabled.
- The stack runs with Docker Compose.
- HTTPS nginx deployment is documented.

## 16. Success Metrics

- Time from Docker Compose start to editable file: under 5 minutes.
- File open latency for local filesystem adapter: under 1 second for files below 5 MB.
- Save success rate: above 99% in normal operation.
- No token leaks in application logs.
- Integration requires no custom frontend work in the host app beyond opening the editor URL.

## 17. Risks

- Excalidraw frontend may not expose enough hooks for clean external load/save.
- Live collaboration state and file save state can drift if save behavior is not designed carefully.
- Locking can frustrate users if stale locks are not refreshed and cleaned correctly.
- A WOPI-like protocol may create expectations of full WOPI compatibility.
- Existing storage backend may overlap with the new gateway responsibilities.

## 18. Open Questions

- Should the gateway aim for real WOPI endpoint compatibility later, or stay WOPI-inspired only?
- Should file version be a numeric revision, hash, timestamp, or host-provided opaque string?
- Should autosave be enabled by default?
- Should save be explicit only, or both explicit and periodic?
- Should collaboration rooms be derived from file ID directly or from an active session ID?
- Should external host storage be push-based through gateway or callback-based to the host app?
- What is the first real host application to integrate with?

## 19. Recommended Next Step

Create `docs/technical-design.md` with concrete implementation choices:

- Gateway stack and framework.
- Endpoint contracts.
- Token format.
- Storage adapter interface.
- Compose/nginx changes.
- Excalidraw frontend integration path.
