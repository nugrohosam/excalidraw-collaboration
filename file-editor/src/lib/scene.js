export function normalizeScene(contents) {
  return {
    type: "excalidraw",
    version: contents.version || 2,
    source: contents.source || "excalidraw-oss-editor",
    elements: contents.elements || [],
    appState: sanitizeAppState(contents.appState || {}),
    files: contents.files || {}
  };
}

export function elementsById(elements) {
  const map = new Map();
  for (const element of elements || []) {
    if (element?.id) {
      map.set(element.id, cloneData(element));
    }
  }
  return map;
}

export function filesById(files) {
  const map = new Map();
  for (const [id, file] of Object.entries(files || {})) {
    map.set(id, cloneData(file));
  }
  return map;
}

export function changedElementsSince(previousElements, elements) {
  const changedElements = [];

  for (const element of elements || []) {
    if (!element?.id) {
      continue;
    }

    const previousElement = previousElements.get(element.id);
    if (!previousElement || isElementNewer(element, previousElement) || elementHash(element) !== elementHash(previousElement)) {
      changedElements.push(element);
    }
  }

  return changedElements;
}

export function changedFilesSince(previousFiles, files) {
  const changedFiles = {};

  for (const [id, file] of Object.entries(files || {})) {
    const previousFile = previousFiles.get(id);
    if (!previousFile || elementHash(file) !== elementHash(previousFile)) {
      changedFiles[id] = file;
    }
  }

  return changedFiles;
}

export function mergeElementsById(currentElements, incomingElements) {
  const merged = elementsById(currentElements || []);

  for (const element of incomingElements || []) {
    if (!element?.id) {
      continue;
    }

    const currentElement = merged.get(element.id);
    if (!currentElement || isElementNewer(element, currentElement)) {
      merged.set(element.id, cloneData(element));
    }
  }

  return Array.from(merged.values());
}

export function removedKeysSince(previousMap, nextMap) {
  const removedKeys = [];

  for (const key of previousMap.keys()) {
    if (!nextMap.has(key)) {
      removedKeys.push(key);
    }
  }

  return removedKeys;
}

export function cloneData(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function hasAnyElements(elements) {
  return Array.isArray(elements) && elements.length > 0;
}

export function toUint8Array(value) {
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

export function sanitizeAppState(appState) {
  const {
    collaborators,
    contextMenu,
    openDialog,
    openMenu,
    selectedElementIds,
    selectedGroupIds,
    editingElement,
    editingGroupId,
    resizingElement,
    draggingElement,
    ...rest
  } = appState || {};

  return rest;
}

function isElementNewer(nextElement, currentElement) {
  const nextVersion = Number(nextElement.version || 0);
  const currentVersion = Number(currentElement.version || 0);

  if (nextVersion !== currentVersion) {
    return nextVersion > currentVersion;
  }

  return Number(nextElement.versionNonce || 0) !== Number(currentElement.versionNonce || 0);
}

function elementHash(element) {
  return JSON.stringify(element || {});
}
