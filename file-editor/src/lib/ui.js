export function trimRight(value) {
  return value.replace(/\/+$/, "");
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function userColor(userId) {
  const colors = ["#2f6fed", "#c2410c", "#047857", "#7c3aed", "#be123c", "#0f766e"];
  let hash = 0;
  for (const char of userId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return colors[hash % colors.length];
}

export function collaborationLabel(collabState) {
  if (collabState.status === "error") {
    return "collab error";
  }
  if (collabState.status === "online") {
    const count = collabState.users.length;
    return `${count || 1} online`;
  }
  if (collabState.status === "connecting") {
    return "connecting";
  }
  return "offline";
}
