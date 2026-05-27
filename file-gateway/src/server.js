import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { Server as SocketIOServer } from "socket.io";
import * as Y from "yjs";

const config = {
  port: numberEnv("PORT", 8090),
  appPublicUrl: trimRight(process.env.APP_PUBLIC_URL || "http://localhost"),
  editorOpenPath: normalizeOpenPath(process.env.EDITOR_OPEN_PATH || "/"),
  gatewayPublicUrl: trimRight(process.env.GATEWAY_PUBLIC_URL || "http://localhost:8090"),
  hostApiKey: process.env.HOST_API_KEY || "",
  tokenSecret: process.env.TOKEN_SECRET || "dev-secret-change-me",
  tokenTtlSeconds: numberEnv("TOKEN_TTL_SECONDS", 3600),
  storageAdapter: process.env.STORAGE_ADAPTER || "filesystem",
  filesystemStoragePath: process.env.FILESYSTEM_STORAGE_PATH || "/data/files",
  hostStorageBaseUrl: trimRight(process.env.HOST_STORAGE_BASE_URL || ""),
  hostStorageApiKey: process.env.HOST_STORAGE_API_KEY || "",
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS || "*"),
  maxBodyBytes: numberEnv("MAX_BODY_BYTES", 10 * 1024 * 1024),
  lockTtlSeconds: numberEnv("LOCK_TTL_SECONDS", 1800)
};

if (!["filesystem", "http"].includes(config.storageAdapter)) {
  throw new Error(`Unsupported STORAGE_ADAPTER: ${config.storageAdapter}`);
}

if (config.storageAdapter === "http" && !config.hostStorageBaseUrl) {
  throw new Error("HOST_STORAGE_BASE_URL is required when STORAGE_ADAPTER=http");
}

if (config.tokenSecret === "dev-secret-change-me" && process.env.NODE_ENV === "production") {
  console.warn("TOKEN_SECRET is using the development default. Set a strong secret before production use.");
}

const storage =
  config.storageAdapter === "http"
    ? createHttpStorage(config.hostStorageBaseUrl, config.hostStorageApiKey)
    : createFilesystemStorage(config.filesystemStoragePath);

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (handleCors(req, res)) {
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && requestUrl.pathname === "/oss/discovery") {
      return sendJson(res, 200, discoveryResponse());
    }

    const sessionMatch = requestUrl.pathname.match(/^\/api\/files\/([^/]+)\/sessions$/);
    if (req.method === "POST" && sessionMatch) {
      const fileId = safeFileId(sessionMatch[1]);
      verifyHostRequest(req);
      const body = await readJsonBody(req);
      return createSession(res, fileId, body);
    }

    const fileInfoMatch = requestUrl.pathname.match(/^\/api\/oss\/files\/([^/]+)$/);
    if (req.method === "GET" && fileInfoMatch) {
      const fileId = safeFileId(fileInfoMatch[1]);
      const claims = verifyRequestToken(req, requestUrl, fileId);
      const fileInfo = await storage.getFileInfo(fileId, claims);
      return sendJson(res, 200, toWopiFileInfo(fileInfo, claims));
    }

    const contentsMatch = requestUrl.pathname.match(/^\/api\/oss\/files\/([^/]+)\/contents$/);
    if (contentsMatch) {
      const fileId = safeFileId(contentsMatch[1]);
      const claims = verifyRequestToken(req, requestUrl, fileId);

      if (req.method === "GET") {
        const content = await storage.getFileContents(fileId, claims);
        return send(res, 200, content, "application/json; charset=utf-8");
      }

      if (req.method === "PUT") {
        if (claims.permission !== "edit") {
          throw httpError(403, "Token does not allow writes");
        }

        const content = await readTextBody(req);
        JSON.parse(content);
        const result = await storage.putFileContents(fileId, content, {
          ...claims,
          expectedVersion: req.headers["x-file-version"],
          lockId: req.headers["x-lock"],
        });
        return sendJson(res, 200, result);
      }
    }

    const lockMatch = requestUrl.pathname.match(/^\/api\/oss\/files\/([^/]+)\/(lock|unlock)$/);
    if (req.method === "POST" && lockMatch) {
      const fileId = safeFileId(lockMatch[1]);
      const action = lockMatch[2];
      const claims = verifyRequestToken(req, requestUrl, fileId);

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
});

const realtimeDocs = new Map();
const io = new SocketIOServer(server, {
  path: "/oss-socket.io",
  maxHttpBufferSize: config.maxBodyBytes,
  cors: {
    origin: config.allowedOrigins.includes("*") ? "*" : config.allowedOrigins,
    methods: ["GET", "POST"]
  }
});

io.use((socket, next) => {
  try {
    const fileId = safeFileId(socket.handshake.auth?.fileId || "");
    const accessToken = String(socket.handshake.auth?.accessToken || "");
    const claims = verifyToken(accessToken);

    if (claims.fileId !== fileId) {
      throw httpError(403, "Token file does not match realtime file");
    }

    socket.data.fileId = fileId;
    socket.data.claims = claims;
    next();
  } catch (error) {
    next(new Error(error.message || "Realtime authentication failed"));
  }
});

io.on("connection", (socket) => {
  const fileId = socket.data.fileId;
  const claims = socket.data.claims;
  const room = realtimeRoom(fileId);

  socket.join(room);

  const ydoc = getRealtimeDoc(fileId);
  socket.emit("yjs:sync", Y.encodeStateAsUpdate(ydoc));

  emitPresence(room, fileId);

  socket.on("yjs:update", (update, ack) => {
    if (claims.permission !== "edit") {
      ack?.({ ok: false, error: "Token does not allow realtime updates" });
      return;
    }

    try {
      const binaryUpdate = toUint8Array(update);
      Y.applyUpdate(ydoc, binaryUpdate, socket.id);
      socket.to(room).emit("yjs:update", binaryUpdate);
      ack?.({ ok: true });
    } catch (error) {
      ack?.({ ok: false, error: error.message || "Invalid Yjs update" });
    }
  });

  socket.on("pointer:update", (pointer) => {
    socket.to(room).emit("pointer:update", {
      fileId,
      pointer,
      user: {
        id: claims.userId,
        name: claims.userName
      },
      updatedAt: new Date().toISOString()
    });
  });

  socket.on("disconnect", async () => {
    socket.to(room).emit("pointer:leave", {
      fileId,
      user: {
        id: claims.userId,
        name: claims.userName
      }
    });
    emitPresence(room, fileId);
    const remainingSockets = await io.in(room).fetchSockets();
    if (remainingSockets.length === 0) {
      const roomDoc = realtimeDocs.get(fileId);
      roomDoc?.destroy();
      realtimeDocs.delete(fileId);
    }
  });
});

await storage.init();

server.listen(config.port, () => {
  console.log(`file-gateway listening on :${config.port}`);
});

function discoveryResponse() {
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

function realtimeRoom(fileId) {
  return `oss:file:${fileId}`;
}

function getRealtimeDoc(fileId) {
  let ydoc = realtimeDocs.get(fileId);
  if (!ydoc) {
    ydoc = new Y.Doc();
    realtimeDocs.set(fileId, ydoc);
  }
  return ydoc;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  throw new Error("Expected binary Yjs update");
}

async function emitPresence(room, fileId) {
  const sockets = await io.in(room).fetchSockets();
  io.to(room).emit("presence:update", {
    fileId,
    users: sockets.map((socket) => ({
      id: socket.data.claims.userId,
      name: socket.data.claims.userName
    }))
  });
}

function createSession(res, fileId, body) {
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
  const token = signToken({
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

function verifyHostRequest(req) {
  if (!config.hostApiKey) {
    return;
  }

  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const apiKey = req.headers["x-gateway-api-key"] || bearerToken;

  if (apiKey !== config.hostApiKey) {
    throw httpError(401, "Host API key is required");
  }
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

function createFilesystemStorage(rootDir) {
  const metaDir = path.join(rootDir, ".meta");

  return {
    async init() {
      await mkdir(rootDir, { recursive: true });
      await mkdir(metaDir, { recursive: true });
    },

    async getFileInfo(fileId) {
      const filePath = pathForFile(fileId);
      let fileStat;

      try {
        fileStat = await stat(filePath);
      } catch (error) {
        if (error.code === "ENOENT") {
          await writeInitialFile(fileId);
          fileStat = await stat(filePath);
        } else {
          throw error;
        }
      }

      const meta = await readMeta(fileId);
      return {
        fileId,
        fileName: `${fileId}.excalidraw`,
        size: fileStat.size,
        version: meta.version,
        updatedAt: meta.updatedAt,
        updatedBy: meta.updatedBy
      };
    },

    async getFileContents(fileId) {
      await this.getFileInfo(fileId);
      return readFile(pathForFile(fileId), "utf8");
    },

    async putFileContents(fileId, content, options) {
      await this.getFileInfo(fileId);
      const meta = await readMeta(fileId);
      const currentLock = await readLock(fileId);

      if (currentLock && currentLock.lockId !== options.lockId) {
        throw httpError(409, "File is locked by another session");
      }

      if (options.expectedVersion && String(meta.version) !== String(options.expectedVersion)) {
        throw httpError(409, "File version conflict");
      }

      const nextVersion = Number(meta.version || 0) + 1;
      const nextMeta = {
        version: nextVersion,
        updatedAt: new Date().toISOString(),
        updatedBy: {
          id: options.userId,
          name: options.userName
        }
      };

      await atomicWrite(pathForFile(fileId), content);
      await writeMeta(fileId, nextMeta);

      return {
        version: String(nextVersion),
        savedAt: nextMeta.updatedAt
      };
    },

    async lockFile(fileId, lockId, claims, ttlSeconds) {
      await this.getFileInfo(fileId);
      const currentLock = await readLock(fileId);

      if (currentLock && currentLock.lockId !== lockId) {
        throw httpError(409, "File is already locked");
      }

      const lock = {
        fileId,
        lockId,
        ownerUserId: claims.userId,
        ownerUserName: claims.userName,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        refreshedAt: new Date().toISOString()
      };

      await atomicWrite(lockPath(fileId), JSON.stringify(lock, null, 2));
      return lock;
    },

    async unlockFile(fileId, lockId) {
      const currentLock = await readLock(fileId);
      if (!currentLock) {
        return;
      }
      if (currentLock.lockId !== lockId) {
        throw httpError(409, "Lock mismatch");
      }
      await unlink(lockPath(fileId));
    }
  };

  function pathForFile(fileId) {
    return path.join(rootDir, `${fileId}.excalidraw`);
  }

  function metaPath(fileId) {
    return path.join(metaDir, `${fileId}.json`);
  }

  function lockPath(fileId) {
    return path.join(metaDir, `${fileId}.lock.json`);
  }

  async function readMeta(fileId) {
    try {
      return JSON.parse(await readFile(metaPath(fileId), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      const meta = {
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: null
      };
      await writeMeta(fileId, meta);
      return meta;
    }
  }

  async function writeMeta(fileId, meta) {
    await atomicWrite(metaPath(fileId), JSON.stringify(meta, null, 2));
  }

  async function readLock(fileId) {
    try {
      const lock = JSON.parse(await readFile(lockPath(fileId), "utf8"));
      if (Date.parse(lock.expiresAt) <= Date.now()) {
        await unlink(lockPath(fileId));
        return null;
      }
      return lock;
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async function writeInitialFile(fileId) {
    const initialScene = {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [],
      appState: {
        viewBackgroundColor: "#ffffff"
      },
      files: {}
    };
    await atomicWrite(pathForFile(fileId), JSON.stringify(initialScene, null, 2));
    await writeMeta(fileId, {
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: null
    });
  }
}

function createHttpStorage(baseUrl, apiKey) {
  return {
    async init() {},

    async getFileInfo(fileId, claims) {
      const response = await dmsFetch("GET", `/files/${encodeURIComponent(fileId)}`, {
        claims
      });

      return {
        fileId,
        fileName: response.fileName || response.BaseFileName || `${fileId}.excalidraw`,
        size: Number(response.size ?? response.Size ?? 0),
        version: String(response.version ?? response.Version ?? "1"),
        updatedAt: response.updatedAt,
        updatedBy: response.updatedBy
      };
    },

    async getFileContents(fileId, claims) {
      return dmsFetchText("GET", `/files/${encodeURIComponent(fileId)}/contents`, {
        claims
      });
    },

    async putFileContents(fileId, content, options) {
      const response = await dmsFetch("PUT", `/files/${encodeURIComponent(fileId)}/contents`, {
        body: content,
        claims: options,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-File-Version": options.expectedVersion || "",
          "X-Lock": options.lockId || ""
        }
      });

      return {
        version: String(response.version ?? response.Version ?? ""),
        savedAt: response.savedAt || response.updatedAt || new Date().toISOString()
      };
    },

    async lockFile(fileId, lockId, claims, ttlSeconds) {
      return dmsFetch("POST", `/files/${encodeURIComponent(fileId)}/lock`, {
        claims,
        body: JSON.stringify({ lockId, ttlSeconds }),
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Lock": lockId
        }
      });
    },

    async unlockFile(fileId, lockId, claims = {}) {
      await dmsFetch("POST", `/files/${encodeURIComponent(fileId)}/unlock`, {
        claims,
        body: JSON.stringify({ lockId }),
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Lock": lockId
        }
      });
    }
  };

  async function dmsFetch(method, route, options = {}) {
    const text = await dmsFetchText(method, route, options);
    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      throw httpError(502, "DMS returned invalid JSON");
    }
  }

  async function dmsFetchText(method, route, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: dmsHeaders(options.headers, options.claims),
      body: options.body
    });

    const text = await response.text();
    if (!response.ok) {
      throw httpError(mapDmsStatus(response.status), text || `DMS request failed with ${response.status}`);
    }
    return text;
  }

  function dmsHeaders(extraHeaders = {}, claims = {}) {
    const headers = {
      ...extraHeaders,
      "X-User-Id": claims.userId || "",
      "X-User-Name": claims.userName || "",
      "X-User-Permission": claims.permission || "",
      "X-File-Url": claims.fileUrl || "",
      "X-File-Name": claims.fileName || ""
    };

    for (const [key, value] of Object.entries(headers)) {
      if (value === "") {
        delete headers[key];
      }
    }

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
  }
}

function mapDmsStatus(status) {
  if ([400, 401, 403, 404, 409, 413].includes(status)) {
    return status;
  }
  return 502;
}

async function atomicWrite(targetPath, content) {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, targetPath);
}

function signToken(payload) {
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = hmac(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyRequestToken(req, requestUrl, fileId) {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const token = bearerToken || requestUrl.searchParams.get("access_token");

  if (!token) {
    throw httpError(401, "Access token is required");
  }

  const claims = verifyToken(token);
  if (claims.fileId !== fileId) {
    throw httpError(403, "Token file does not match request file");
  }
  return claims;
}

function verifyToken(token) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw httpError(401, "Invalid token");
  }

  const [encodedPayload, signature] = parts;
  const expected = hmac(encodedPayload);
  if (!safeEqual(signature, expected)) {
    throw httpError(401, "Invalid token signature");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw httpError(401, "Invalid token payload");
  }

  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw httpError(401, "Token expired");
  }

  if (!payload.fileId || !payload.userId || !payload.userName || !payload.permission) {
    throw httpError(401, "Token missing required claims");
  }

  return payload;
}

function hmac(value) {
  return createHmac("sha256", config.tokenSecret).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

async function readJsonBody(req) {
  const text = await readTextBody(req);
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

async function readTextBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) {
      throw httpError(413, "Request body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function handleCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", config.allowedOrigins.includes("*") ? "*" : origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Version, X-Gateway-Api-Key, X-Lock");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  return false;
}

function isOriginAllowed(origin) {
  return config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin);
}

function sendJson(res, statusCode, body) {
  return send(res, statusCode, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

function send(res, statusCode, body, contentType) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function safeFileId(value) {
  const fileId = decodeURIComponent(value || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(fileId)) {
    throw httpError(400, "Invalid file ID");
  }
  return fileId;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(400, `${name} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function numberEnv(name, fallback) {
  return numberValue(process.env[name], fallback);
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOrigins(value) {
  return value.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function trimRight(value) {
  return value.replace(/\/+$/, "");
}

function normalizeOpenPath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
  return value.endsWith("/") ? `${normalized}/` : normalized;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}
