import { userColor } from "../lib/ui.js";

export function RemotePointers({ pointers }) {
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
