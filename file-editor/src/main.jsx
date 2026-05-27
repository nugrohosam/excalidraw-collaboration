import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import { io } from "socket.io-client";
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
  const [collabState, setCollabState] = useState({ status: "offline", users: [] });
  const [remotePointers, setRemotePointers] = useState({});
  const excalidrawApiRef = useRef(null);
  const latestSceneRef = useRef(null);
  const socketRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const emitTimerRef = useRef(null);
  const pointerTimerRef = useRef(null);
  const pointerAreaRef = useRef(null);
  const pendingRemoteSceneRef = useRef(null);

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
        setCollabState({ status: "offline", users: [] });
        setRemotePointers({});
        excalidrawApiRef.current = null;
        latestSceneRef.current = null;
        pendingRemoteSceneRef.current = null;
        applyingRemoteRef.current = false;
        window.clearTimeout(emitTimerRef.current);
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
    setCollabState({ status: "connecting", users: [] });

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

    socket.on("scene:sync", applyRemoteScene);
    socket.on("scene:update", applyRemoteScene);
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
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken, fileId, gatewayUrl, loadState.status]);

  const handleChange = useCallback((elements, appState, files) => {
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "excalidraw-oss-editor",
      elements,
      appState: sanitizeAppState(appState),
      files: files || {}
    };
    latestSceneRef.current = scene;

    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false;
      return;
    }

    queueRealtimeScene(scene);

    if (saveState.status === "saved") {
      setSaveState({ status: "idle", message: "" });
    }
  }, [fileInfo?.UserCanWrite, saveState.status]);

  const handleSave = useCallback(async () => {
    if (!latestSceneRef.current) {
      setSaveState({ status: "error", message: "Nothing to save yet." });
      return;
    }

    setSaveState({ status: "saving", message: "Saving..." });

    try {
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
          <span className={saveState.status === "error" ? "error-text" : "status-text"}>{saveState.message}</span>
          <button type="button" onClick={handleSave} disabled={saveState.status === "saving" || !fileInfo?.UserCanWrite}>
            {saveState.status === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
      </header>
      <section className="canvas-area" ref={pointerAreaRef} onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave}>
        <Excalidraw
          key={editorSessionKey}
          excalidrawAPI={(api) => {
            excalidrawApiRef.current = api;
            if (pendingRemoteSceneRef.current) {
              applyRemoteScene(pendingRemoteSceneRef.current);
              pendingRemoteSceneRef.current = null;
            }
          }}
          initialData={initialData}
          onChange={handleChange}
          viewModeEnabled={!fileInfo?.UserCanWrite}
        />
        <RemotePointers pointers={remotePointers} />
      </section>
    </main>
  );

  function applyRemoteScene(payload) {
    const scene = payload.scene || payload;
    if (!scene) {
      return;
    }

    if (!excalidrawApiRef.current) {
      pendingRemoteSceneRef.current = payload;
      setInitialData({
        elements: scene.elements || [],
        appState: scene.appState || {},
        files: scene.files || {}
      });
      latestSceneRef.current = normalizeScene(scene);
      return;
    }

    applyingRemoteRef.current = true;
    latestSceneRef.current = normalizeScene(scene);

    if (scene.files && typeof excalidrawApiRef.current.addFiles === "function") {
      excalidrawApiRef.current.addFiles(Object.values(scene.files));
    }

    excalidrawApiRef.current.updateScene({
      elements: scene.elements || [],
      appState: sanitizeAppState(scene.appState || {})
    });
  }

  function queueRealtimeScene(scene) {
    const socket = socketRef.current;
    if (!socket?.connected || !fileInfo?.UserCanWrite) {
      return;
    }

    window.clearTimeout(emitTimerRef.current);
    emitTimerRef.current = window.setTimeout(() => {
      socket.emit("scene:update", scene);
    }, 250);
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
