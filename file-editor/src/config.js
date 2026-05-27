import { trimRight } from "./lib/ui.js";

const defaultGatewayUrl = import.meta.env.VITE_GATEWAY_URL || "";

export function readEditorConfig() {
  const params = new URLSearchParams(window.location.search);
  const fileId = params.get("file_id") || "";
  const accessToken = params.get("access_token") || "";
  const gatewayUrl = trimRight(params.get("gateway_url") || defaultGatewayUrl || window.location.origin);

  return {
    accessToken,
    editorSessionKey: `${fileId}:${accessToken}`,
    fileId,
    gatewayUrl
  };
}
