import { createFilesystemStorage } from "./filesystem.js";
import { createHttpStorage } from "./http.js";

export function createStorage(config) {
  return config.storageAdapter === "http"
    ? createHttpStorage(config.hostStorageBaseUrl, config.hostStorageApiKey)
    : createFilesystemStorage(config.filesystemStoragePath);
}
