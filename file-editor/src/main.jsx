import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import { io } from "socket.io-client";
import * as Y from "yjs";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";

const defaultGatewayUrl = import.meta.env.VITE_GATEWAY_URL || "";

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const fileId = params.get("file_id") || "";
  const accessToken = params.get("access_token") || "";
  const gatewayUrl = trimRight(params.get("gateway_url") || defaultGatewayUrl || window.location.origin);
  const editorSessionKey = `${fileId}:${accessToken}`;

  const [fileInfo, setFileInfo] = useState(null);
  const [initialData, setInitialData] = useState(null);
  const [loadState, setLoadState] = useState({ status: "loading", message: "Loading drawing..." });
  const [saveState, setSaveState] = useState({ status: "idle", message: "" });
  const [remoteSaveState, setRemoteSaveState] = useState(null);
  const [collabState, setCollabState] = useState({ status: "offline", users: [] });
  const [remotePointers, setRemotePointers] = useState({});
  const excalidrawApiRef = useRef(null);
  const latestSceneRef = useRef(null);
  const socketRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const pointerTimerRef = useRef(null);
  const pointerAreaRef = useRef(null);
  const initialSceneHadElementsRef = useRef(false);
  const loadedInitialSceneRef = useRef(false);
  const acceptedLocalChangeRef = useRef(false);
  const previousElementsRef = useRef(new Map());
  const previousFilesRef = useRef(new Map());
  const ydocRef = useRef(null);
  const yElementsRef = useRef(null);
  const yFilesRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFile() {
      if (!fileId || !accessToken) {
        setLoadState({
          status: "error",
          message: "Missing file_id or access_token."
        });
        return;
      }

      try {
        setLoadState({ status: "loading", message: "Loading drawing..." });
        setFileInfo(null);
        setInitialData(null);
        setSaveState({ status: "idle", message: "" });
        setRemoteSaveState(null);
        setCollabState({ status: "offline", users: [] });
        setRemotePointers({});
        excalidrawApiRef.current = null;
        latestSceneRef.current = null;
        applyingRemoteRef.current = false;
        initialSceneHadElementsRef.current = false;
        loadedInitialSceneRef.current = false;
        acceptedLocalChangeRef.current = false;
        previousElementsRef.current = new Map();
        previousFilesRef.current = new Map();
        ydocRef.current?.destroy();
        ydocRef.current = null;
        yElementsRef.current = null;
        yFilesRef.current = null;
        window.clearTimeout(pointerTimerRef.current);

        const info = await gatewayJson(`${gatewayUrl}/api/oss/files/${encodeURIComponent(fileId)}`, accessToken);
        const contents = await gatewayJson(
          `${gatewayUrl}/api/oss/files/${encodeURIComponent(fileId)}/contents`,
          accessToken
        );

        if (cancelled) {
          return;
        }

        setFileInfo(info);
        setInitialData({
          elements: contents.elements || [],
          appState: contents.appState || {},
          files: contents.files || {}
        });
        latestSceneRef.current = normalizeScene(contents);
        initialSceneHadElementsRef.current = hasAnyElements(contents.elements);
        previousElementsRef.current = elementsById(contents.elements || []);
        previousFilesRef.current = filesById(contents.files || {});
        loadedInitialSceneRef.current = true;
        setLoadState({ status: "ready", message: "" });
      } catch (error) {
        if (!cancelled) {
          setLoadState({ status: "error", message: error.message });
        }
      }
    }

    loadFile();

    return () => {
      cancelled = true;
    };
  }, [accessToken, fileId, gatewayUrl]);

  useEffect(() => {
    if (loadState.status !== "ready" || !fileId || !accessToken) {
      return undefined;
    }

    const socket = io(gatewayUrl, {
      path: "/oss-socket.io",
      auth: {
        fileId,
        accessToken
      }
    });

    socketRef.current = socket;
    const ydoc = new Y.Doc();
    const yElements = ydoc.getMap("elements");
    const yFiles = ydoc.getMap("files");
    ydocRef.current = ydoc;
    yElementsRef.current = yElements;
    yFilesRef.current = yFiles;
    setCollabState({ status: "connecting", users: [] });

    ydoc.on("update", (update, origin) => {
      if (origin === "remote" || !socket.connected || !fileInfo?.UserCanWrite) {
        return;
      }

      socket.emit("yjs:update", update);
    });

    const observeYjsScene = (event) => {
      if (["local", "seed"].includes(event.transaction.origin)) {
        return;
      }
      applyYjsScene();
    };

    yElements.observe(observeYjsScene);
    yFiles.observe(observeYjsScene);

    socket.on("connect", () => {
      setCollabState((current) => ({ ...current, status: "online" }));
    });

    socket.on("connect_error", (error) => {
      setCollabState({ status: "error", users: [], message: error.message });
    });

    socket.on("presence:update", (presence) => {
      setCollabState({
        status: socket.connected ? "online" : "connecting",
        users: presence.users || []
      });
    });

    socket.on("yjs:sync", (update) => {
      Y.applyUpdate(ydoc, toUint8Array(update), "remote");

      if (yElements.size === 0 && yFiles.size === 0) {
        seedYjsFromScene(latestSceneRef.current);
      } else {
        applyYjsScene();
      }
    });
    socket.on("yjs:update", (update) => {
      Y.applyUpdate(ydoc, toUint8Array(update), "remote");
    });
    socket.on("save:state", (state) => {
      if (state?.active && state.ownerSocketId !== socket.id) {
        setRemoteSaveState(state);
      } else {
        setRemoteSaveState(null);
      }
    });
    socket.on("pointer:update", (payload) => {
      if (!payload.user?.id || !payload.pointer) {
        return;
      }

      setRemotePointers((current) => ({
        ...current,
        [payload.user.id]: {
          user: payload.user,
          pointer: payload.pointer,
          updatedAt: Date.now()
        }
      }));
    });
    socket.on("pointer:leave", (payload) => {
      if (!payload.user?.id) {
        return;
      }

      setRemotePointers((current) => {
        const next = { ...current };
        delete next[payload.user.id];
        return next;
      });
    });

    return () => {
      yElements.unobserve(observeYjsScene);
      yFiles.unobserve(observeYjsScene);
      ydoc.destroy();
      socket.disconnect();
      socketRef.current = null;
      if (ydocRef.current === ydoc) {
        ydocRef.current = null;
        yElementsRef.current = null;
        yFilesRef.current = null;
      }
    };
  }, [accessToken, fileId, fileInfo?.UserCanWrite, gatewayUrl, loadState.status]);

  const handleChange = useCallback((elements, appState, files) => {
    if (!loadedInitialSceneRef.current) {
      return;
    }

    const scene = {
      type: "excalidraw",
      version: 2,
      source: "excalidraw-oss-editor",
      elements,
      appState: sanitizeAppState(appState),
      files: files || {}
    };

    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false;
      latestSceneRef.current = scene;
      previousElementsRef.current = elementsById(elements);
      previousFilesRef.current = filesById(files || {});
      acceptedLocalChangeRef.current = true;
      return;
    }

    if (remoteSaveState?.active || saveState.status === "saving") {
      return;
    }

    if (!acceptedLocalChangeRef.current && initialSceneHadElementsRef.current && !hasAnyElements(elements)) {
      return;
    }

    latestSceneRef.current = scene;
    const nextElements = elementsById(elements);
    const nextFiles = filesById(files || {});
    const changedElements = changedElementsSince(previousElementsRef.current, elements);
    const changedFiles = changedFilesSince(previousFilesRef.current, files || {});
    const removedFileIds = removedKeysSince(previousFilesRef.current, nextFiles);
    previousElementsRef.current = nextElements;
    previousFilesRef.current = nextFiles;
    acceptedLocalChangeRef.current = true;
    syncYjsChanges(changedElements, changedFiles, removedFileIds);

    if (saveState.status === "saved") {
      setSaveState({ status: "idle", message: "" });
    }
  }, [fileInfo?.UserCanWrite, remoteSaveState?.active, saveState.status]);

  const handleSave = useCallback(async () => {
    if (!latestSceneRef.current) {
      setSaveState({ status: "error", message: "Nothing to save yet." });
      return;
    }

    setSaveState({ status: "saving", message: "Saving..." });
    let saveLockStarted = false;

    try {
      if (socketRef.current?.connected) {
        const lockResult = await emitWithAck(socketRef.current, "save:start");
        if (!lockResult.ok) {
          throw new Error(lockResult.error || "Another user is saving");
        }
        saveLockStarted = true;

        if (lockResult.snapshot) {
          Y.applyUpdate(ydocRef.current, toUint8Array(lockResult.snapshot), "remote");
          applyYjsScene();
        }
      }

      const response = await fetch(`${gatewayUrl}/api/oss/files/${encodeURIComponent(fileId)}/contents`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(fileInfo?.Version ? { "X-File-Version": fileInfo.Version } : {})
        },
        body: JSON.stringify(latestSceneRef.current)
      });

      const text = await response.text();
      const body = text ? JSON.parse(text) : {};

      if (!response.ok) {
        throw new Error(body.error || `Save failed with ${response.status}`);
      }

      setFileInfo((current) => ({
        ...(current || {}),
        Version: body.version || current?.Version,
        Size: JSON.stringify(latestSceneRef.current).length
      }));
      setSaveState({
        status: "saved",
        message: `Saved${body.version ? ` as version ${body.version}` : ""}.`
      });
    } catch (error) {
      setSaveState({ status: "error", message: error.message });
    } finally {
      if (saveLockStarted) {
        socketRef.current?.emit("save:end");
      }
    }
  }, [accessToken, fileId, fileInfo?.Version, gatewayUrl]);

  if (loadState.status === "loading" || loadState.status === "error") {
    return (
      <main className="center-screen">
        <section className="status-panel">
          <h1>Excalidraw OSS Editor</h1>
          <p className={loadState.status === "error" ? "error-text" : ""}>{loadState.message}</p>
        </section>
      </main>
    );
  }

  const saveFreezeActive = saveState.status === "saving" || Boolean(remoteSaveState?.active);

  return (
    <main className="editor-shell">
      <header className="toolbar">
        <div>
          <strong>{fileInfo?.BaseFileName || `${fileId}.excalidraw`}</strong>
          <span>
            Version {fileInfo?.Version || "-"} · {collaborationLabel(collabState)}
          </span>
        </div>
        <div className="actions">
          <span className={saveState.status === "error" ? "error-text" : "status-text"}>
            {remoteSaveState?.active ? `${remoteSaveState.user?.name || "Another user"} is saving...` : saveState.message}
          </span>
          <button type="button" onClick={handleSave} disabled={saveFreezeActive || !fileInfo?.UserCanWrite}>
            {saveState.status === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </header>
      <section className="canvas-area" ref={pointerAreaRef} onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave}>
        <Excalidraw
          key={editorSessionKey}
          excalidrawAPI={(api) => {
            excalidrawApiRef.current = api;
            if (yElementsRef.current?.size) {
              applyYjsScene();
            }
          }}
          initialData={initialData}
          onChange={handleChange}
          viewModeEnabled={!fileInfo?.UserCanWrite || saveFreezeActive}
        />
        <RemotePointers pointers={remotePointers} />
      </section>
    </main>
  );

  function seedYjsFromScene(scene) {
    if (!scene || !fileInfo?.UserCanWrite) {
      return;
    }

    const ydoc = ydocRef.current;
    const yElements = yElementsRef.current;
    const yFiles = yFilesRef.current;
    if (!ydoc || !yElements || !yFiles) {
      return;
    }

    ydoc.transact(() => {
      for (const element of scene.elements || []) {
        if (element?.id) {
          yElements.set(element.id, cloneData(element));
        }
      }

      for (const [id, file] of Object.entries(scene.files || {})) {
        yFiles.set(id, cloneData(file));
      }
    }, "seed");
  }

  function syncYjsChanges(changedElements, changedFiles, removedFileIds) {
    const ydoc = ydocRef.current;
    const yElements = yElementsRef.current;
    const yFiles = yFilesRef.current;
    if (!ydoc || !yElements || !yFiles || !fileInfo?.UserCanWrite) {
      return;
    }

    if (
      changedElements.length === 0 &&
      Object.keys(changedFiles).length === 0 &&
      removedFileIds.length === 0
    ) {
      return;
    }

    ydoc.transact(() => {
      for (const element of changedElements) {
        if (element?.id) {
          yElements.set(element.id, cloneData(element));
        }
      }

      for (const [id, file] of Object.entries(changedFiles)) {
        yFiles.set(id, cloneData(file));
      }

      for (const fileId of removedFileIds) {
        yFiles.delete(fileId);
      }
    }, "local");
  }

  function applyYjsScene() {
    const yElements = yElementsRef.current;
    const yFiles = yFilesRef.current;
    if (!yElements || !yFiles) {
      return;
    }

    const elements = mergeElementsById(latestSceneRef.current?.elements || [], Array.from(yElements.values()));
    const files = cloneData(Object.fromEntries(yFiles.entries()));
    latestSceneRef.current = {
      ...(latestSceneRef.current || normalizeScene({})),
      elements,
      files: {
        ...(latestSceneRef.current?.files || {}),
        ...files
      }
    };
    previousElementsRef.current = elementsById(elements);
    previousFilesRef.current = filesById(latestSceneRef.current.files);

    if (typeof excalidrawApiRef.current?.addFiles === "function") {
      excalidrawApiRef.current.addFiles(Object.values(files));
    }

    if (excalidrawApiRef.current) {
      applyingRemoteRef.current = true;
      excalidrawApiRef.current.updateScene({ elements });
    }
  }

  function handlePointerMove(event) {
    const socket = socketRef.current;
    const area = pointerAreaRef.current;
    if (!socket?.connected || !area) {
      return;
    }

    const rect = area.getBoundingClientRect();
    const pointer = {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
    };

    window.clearTimeout(pointerTimerRef.current);
    pointerTimerRef.current = window.setTimeout(() => {
      socket.emit("pointer:update", pointer);
    }, 32);
  }

  function handlePointerLeave() {
    const socket = socketRef.current;
    if (socket?.connected) {
      socket.emit("pointer:update", { hidden: true });
    }
  }
}

function RemotePointers({ pointers }) {
  return (
    <div className="remote-pointer-layer" aria-hidden="true">
      {Object.values(pointers)
        .filter(({ pointer }) => pointer && !pointer.hidden)
        .map(({ user, pointer }) => (
          <div
            className="remote-pointer"
            key={user.id}
            style={{
              left: `${pointer.x * 100}%`,
              top: `${pointer.y * 100}%`,
              "--cursor-color": userColor(user.id)
            }}
          >
            <svg viewBox="0 0 18 18" width="18" height="18">
              <path d="M2 1.5 15.5 8 9.3 10.1 6.6 16.3 2 1.5Z" />
            </svg>
            <span>{user.name}</span>
          </div>
        ))}
    </div>
  );
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

function normalizeScene(contents) {
  return {
    type: "excalidraw",
    version: contents.version || 2,
    source: contents.source || "excalidraw-oss-editor",
    elements: contents.elements || [],
    appState: sanitizeAppState(contents.appState || {}),
    files: contents.files || {}
  };
}

function elementsById(elements) {
  const map = new Map();
  for (const element of elements || []) {
    if (element?.id) {
      map.set(element.id, cloneData(element));
    }
  }
  return map;
}

function filesById(files) {
  const map = new Map();
  for (const [id, file] of Object.entries(files || {})) {
    map.set(id, cloneData(file));
  }
  return map;
}

function changedElementsSince(previousElements, elements) {
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

function changedFilesSince(previousFiles, files) {
  const changedFiles = {};

  for (const [id, file] of Object.entries(files || {})) {
    const previousFile = previousFiles.get(id);
    if (!previousFile || elementHash(file) !== elementHash(previousFile)) {
      changedFiles[id] = file;
    }
  }

  return changedFiles;
}

function mergeElementsById(currentElements, incomingElements) {
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

function removedKeysSince(previousMap, nextMap) {
  const removedKeys = [];

  for (const key of previousMap.keys()) {
    if (!nextMap.has(key)) {
      removedKeys.push(key);
    }
  }

  return removedKeys;
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

function cloneData(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function hasAnyElements(elements) {
  return Array.isArray(elements) && elements.length > 0;
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

function sanitizeAppState(appState) {
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

function trimRight(value) {
  return value.replace(/\/+$/, "");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit(event, payload, (error, response) => {
      if (error) {
        resolve({ ok: false, error: "Realtime save lock timed out" });
        return;
      }

      resolve(response || { ok: true });
    });
  });
}

function userColor(userId) {
  const colors = ["#2f6fed", "#c2410c", "#047857", "#7c3aed", "#be123c", "#0f766e"];
  let hash = 0;
  for (const char of userId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return colors[hash % colors.length];
}

function collaborationLabel(collabState) {
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

createRoot(document.getElementById("root")).render(<App />);
