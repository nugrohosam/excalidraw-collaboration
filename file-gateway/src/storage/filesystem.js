import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { httpError } from "../lib/errors.js";

export function createFilesystemStorage(rootDir) {
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

async function atomicWrite(targetPath, content) {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, targetPath);
}
