import { normalizeOpenPath, numberEnv, parseOrigins, trimRight } from "./lib/validation.js";

export function readConfig() {
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

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!["filesystem", "http"].includes(config.storageAdapter)) {
    throw new Error(`Unsupported STORAGE_ADAPTER: ${config.storageAdapter}`);
  }

  if (config.storageAdapter === "http" && !config.hostStorageBaseUrl) {
    throw new Error("HOST_STORAGE_BASE_URL is required when STORAGE_ADAPTER=http");
  }

  if (config.tokenSecret === "dev-secret-change-me" && process.env.NODE_ENV === "production") {
    console.warn("TOKEN_SECRET is using the development default. Set a strong secret before production use.");
  }
}
