import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { io } from "socket.io-client";
import * as Y from "yjs";
import { saveGatewayFile, loadGatewayFile } from "./api/gateway.js";
import { RemotePointers } from "./components/RemotePointers.jsx";
import { readEditorConfig } from "./config.js";
import {
  changedElementsSince,
  changedFilesSince,
  cloneData,
  elementsById,
  filesById,
  hasAnyElements,
  mergeElementsById,
  normalizeScene,
  removedKeysSince,
  sanitizeAppState,
  toUint8Array
} from "./lib/scene.js";
import { clamp, collaborationLabel } from "./lib/ui.js";

export function App() {
  const { accessToken, editorSessionKey, fileId, gatewayUrl } = useMemo(readEditorConfig, []);

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
  const pointerTimerRef = useRef(null);
  const pointerAreaRef = useRef(null);
  const initialSceneHadElementsRef = useRef(false);
  const loadedInitialSceneRef = useRef(false);
  const acceptedLocalChangeRef = useRef(false);
  const previousElementsRef = useRef(new Map());
  const previousFilesRef = useRef(new Map());
  const pendingYjsUpdatesRef = useRef([]);
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
        resetEditorState();
        const { contents, fileInfo: nextFileInfo } = await loadGatewayFile({ accessToken, fileId, gatewayUrl });

        if (cancelled) {
          return;
        }

        setFileInfo(nextFileInfo);
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
      if (origin === "remote" || !fileInfo?.UserCanWrite) {
        return;
      }

      if (socket.connected) {
        socket.emit("yjs:update", update);
      } else {
        pendingYjsUpdatesRef.current.push(update);
      }
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
      flushPendingYjsUpdates(socket);
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
  }, [fileInfo?.UserCanWrite, saveState.status]);

  const handleSave = useCallback(async () => {
    if (!latestSceneRef.current) {
      setSaveState({ status: "error", message: "Nothing to save yet." });
      return;
    }

    setSaveState({ status: "saving", message: "Saving..." });

    try {
      const body = await saveGatewayFile({
        accessToken,
        content: latestSceneRef.current,
        fileId,
        gatewayUrl,
        version: fileInfo?.Version
      });

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
            if (yElementsRef.current?.size) {
              applyYjsScene();
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

  function resetEditorState() {
    setLoadState({ status: "loading", message: "Loading drawing..." });
    setFileInfo(null);
    setInitialData(null);
    setSaveState({ status: "idle", message: "" });
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
    pendingYjsUpdatesRef.current = [];
    ydocRef.current?.destroy();
    ydocRef.current = null;
    yElementsRef.current = null;
    yFilesRef.current = null;
    window.clearTimeout(pointerTimerRef.current);
  }

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

      for (const removedFileId of removedFileIds) {
        yFiles.delete(removedFileId);
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

  function flushPendingYjsUpdates(socket) {
    if (!fileInfo?.UserCanWrite || pendingYjsUpdatesRef.current.length === 0) {
      return;
    }

    const updates = pendingYjsUpdatesRef.current;
    pendingYjsUpdatesRef.current = [];
    socket.emit("yjs:update", updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
  }
}
