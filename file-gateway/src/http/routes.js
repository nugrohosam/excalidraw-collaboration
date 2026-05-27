import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { verifyHostRequest } from "../auth/host.js";
import { httpError } from "../lib/errors.js";
import { numberValue, optionalString, requiredString, safeFileId } from "../lib/validation.js";
import { handleCors, readJsonBody, readTextBody, send, sendJson } from "./respond.js";

export function createHttpHandler({ config, storage, tokenService }) {
  return async function handleRequest(req, res) {
    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (handleCors(req, res, config.allowedOrigins)) {
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && requestUrl.pathname === "/oss/discovery") {
        return sendJson(res, 200, discoveryResponse(config));
      }

      const sessionMatch = requestUrl.pathname.match(/^\/api\/files\/([^/]+)\/sessions$/);
      if (req.method === "POST" && sessionMatch) {
        const fileId = safeFileId(sessionMatch[1]);
        verifyHostRequest(req, config.hostApiKey);
        const body = await readJsonBody(req, config.maxBodyBytes);
        return createSession(res, fileId, body, config, tokenService);
      }

      const fileInfoMatch = requestUrl.pathname.match(/^\/api\/oss\/files\/([^/]+)$/);
      if (req.method === "GET" && fileInfoMatch) {
        const fileId = safeFileId(fileInfoMatch[1]);
        const claims = tokenService.verifyRequestToken(req, requestUrl, fileId);
        const fileInfo = await storage.getFileInfo(fileId, claims);
        return sendJson(res, 200, toWopiFileInfo(fileInfo, claims));
      }

      const contentsMatch = requestUrl.pathname.match(/^\/api\/oss\/files\/([^/]+)\/contents$/);
      if (contentsMatch) {
        const fileId = safeFileId(contentsMatch[1]);
        const claims = tokenService.verifyRequestToken(req, requestUrl, fileId);

        if (req.method === "GET") {
          const content = await storage.getFileContents(fileId, claims);
          return send(res, 200, content, "application/json; charset=utf-8");
        }

        if (req.method === "PUT") {
          if (claims.permission !== "edit") {
            throw httpError(403, "Token does not allow writes");
          }

          const content = await readTextBody(req, config.maxBodyBytes);
          JSON.parse(content);
          const result = await storage.putFileContents(fileId, content, {
            ...claims,
            expectedVersion: req.headers["x-file-version"],
            lockId: req.headers["x-lock"]
          });
          return sendJson(res, 200, result);
        }
      }

      const lockMatch = requestUrl.pathname.match(/^\/api\/oss\/files\/([^/]+)\/(lock|unlock)$/);
      if (req.method === "POST" && lockMatch) {
        const fileId = safeFileId(lockMatch[1]);
        const action = lockMatch[2];
        const claims = tokenService.verifyRequestToken(req, requestUrl, fileId);

        if (claims.permission !== "edit") {
          throw httpError(403, "Token does not allow locks");
        }

        const lockId = String(req.headers["x-lock"] || "");
        if (!lockId) {
          throw httpError(400, "X-Lock header is required");
        }

        if (action === "lock") {
          const lock = await storage.lockFile(fileId, lockId, claims, config.lockTtlSeconds);
          return sendJson(res, 200, lock);
        }

        await storage.unlockFile(fileId, lockId, claims);
        return sendJson(res, 200, { unlocked: true });
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const status = error.statusCode || 500;
      const message = status === 500 ? "Internal server error" : error.message;
      if (status === 500) {
        console.error(error);
      }
      return sendJson(res, status, { error: message });
    }
  };
}

function discoveryResponse(config) {
  const editUrl = `${config.appPublicUrl}${config.editorOpenPath}?file_id={file_id}&access_token={access_token}`;
  return {
    product: "Excalidraw Collaboration Gateway",
    version: "0.1.0",
    actions: [
      { ext: "excalidraw", name: "edit", urlsrc: editUrl },
      { ext: "excalidraw", name: "view", urlsrc: `${editUrl}&readonly=1` }
    ]
  };
}

function createSession(res, fileId, body, config, tokenService) {
  const user = body.user || {};
  const userId = requiredString(user.id, "user.id");
  const userName = requiredString(user.name, "user.name");
  const permission = body.permission || "edit";
  const fileUrl = optionalString(body.fileUrl || body.file?.url);
  const fileName = optionalString(body.fileName || body.file?.name);

  if (!["view", "edit"].includes(permission)) {
    throw httpError(400, "permission must be view or edit");
  }

  const ttlSeconds = Math.min(numberValue(body.ttlSeconds, config.tokenTtlSeconds), 24 * 60 * 60);
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = tokenService.signToken({
    fileId,
    userId,
    userName,
    permission,
    fileUrl,
    fileName,
    exp: expiresAtSeconds,
    nonce: randomUUID()
  });
  const editorUrl = `${config.appPublicUrl}${config.editorOpenPath}?file_id=${encodeURIComponent(fileId)}&access_token=${encodeURIComponent(token)}`;

  return sendJson(res, 201, {
    fileId,
    accessToken: token,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    editorUrl
  });
}

function toWopiFileInfo(fileInfo, claims) {
  return {
    BaseFileName: claims.fileName || fileInfo.fileName,
    OwnerId: "filesystem",
    Size: fileInfo.size,
    UserId: claims.userId,
    UserFriendlyName: claims.userName,
    UserCanWrite: claims.permission === "edit",
    Version: String(fileInfo.version),
    SupportsLocks: true,
    SupportsUpdate: true
  };
}
