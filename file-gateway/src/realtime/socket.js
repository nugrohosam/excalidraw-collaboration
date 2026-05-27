import { Server as SocketIOServer } from "socket.io";
import * as Y from "yjs";
import { httpError } from "../lib/errors.js";
import { safeFileId } from "../lib/validation.js";

export function attachRealtimeServer(server, { allowedOrigins, maxBodyBytes, tokenService }) {
  const realtimeDocs = new Map();
  const io = new SocketIOServer(server, {
    path: "/oss-socket.io",
    maxHttpBufferSize: maxBodyBytes,
    cors: {
      origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
      methods: ["GET", "POST"]
    }
  });

  io.use((socket, next) => {
    try {
      const fileId = safeFileId(socket.handshake.auth?.fileId || "");
      const accessToken = String(socket.handshake.auth?.accessToken || "");
      const claims = tokenService.verifyToken(accessToken);

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

  function getRealtimeDoc(fileId) {
    let ydoc = realtimeDocs.get(fileId);
    if (!ydoc) {
      ydoc = new Y.Doc();
      realtimeDocs.set(fileId, ydoc);
    }
    return ydoc;
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

  return io;
}

function realtimeRoom(fileId) {
  return `oss:file:${fileId}`;
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
