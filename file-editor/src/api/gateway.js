export async function loadGatewayFile({ accessToken, fileId, gatewayUrl }) {
  const fileInfo = await gatewayJson(`${gatewayUrl}/api/oss/files/${encodeURIComponent(fileId)}`, accessToken);
  const contents = await gatewayJson(`${gatewayUrl}/api/oss/files/${encodeURIComponent(fileId)}/contents`, accessToken);

  return { contents, fileInfo };
}

export async function saveGatewayFile({ accessToken, content, fileId, gatewayUrl, version }) {
  const response = await fetch(`${gatewayUrl}/api/oss/files/${encodeURIComponent(fileId)}/contents`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(version ? { "X-File-Version": version } : {})
    },
    body: JSON.stringify(content)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(body.error || `Save failed with ${response.status}`);
  }

  return body;
}

async function gatewayJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(body.error || `Request failed with ${response.status}`);
  }

  return body;
}
