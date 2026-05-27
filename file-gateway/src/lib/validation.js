import { httpError } from "./errors.js";

export function safeFileId(value) {
  const fileId = decodeURIComponent(value || "");
  if (!/^[A-Za-z0-9_.-]+$/.test(fileId)) {
    throw httpError(400, "Invalid file ID");
  }
  return fileId;
}

export function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(400, `${name} is required`);
  }
  return value.trim();
}

export function optionalString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function numberEnv(name, fallback) {
  return numberValue(process.env[name], fallback);
}

export function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOrigins(value) {
  return value.split(",").map((origin) => origin.trim()).filter(Boolean);
}

export function trimRight(value) {
  return value.replace(/\/+$/, "");
}

export function normalizeOpenPath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
  return value.endsWith("/") ? `${normalized}/` : normalized;
}
