import { httpError } from "../lib/errors.js";

export function createHttpStorage(baseUrl, apiKey) {
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
