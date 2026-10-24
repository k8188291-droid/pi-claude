import type { Session } from "../api";

interface Props {
  sessions: Session[] | undefined;
  loading: boolean;
  error?: string;
  activeId?: string;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (session: Session) => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
}

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "剛剛";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(iso).toLocaleDateString();
}

export function Sidebar({ sessions, loading, error, activeId, onNew, onSelect, onDelete, onOpenSettings, onRefresh }: Props) {
  return (
    <aside className="sidebar">
      <button className={`new-btn${activeId ? "" : " active"}`} onClick={onNew}>
        <span className="plus">+</span> New
      </button>
      <div className="sidebar-label">
        <span>Sessions</span>
        <button className="link" onClick={onRefresh} title="重新整理">
          ↻
        </button>
      </div>
      <nav className="session-list">
        {error && <div className="sidebar-error">{error}</div>}
        {!sessions && loading && <div className="muted pad">載入中…</div>}
        {sessions?.length === 0 && <div className="muted pad">還沒有對話</div>}
        {sessions?.map((s) => (
          <div
            key={s.id}
            className={`session-item${s.id === activeId ? " active" : ""}`}
            onClick={() => onSelect(s.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onSelect(s.id)}
          >
            <span className={`status-dot ${s.status}`} title={s.status} />
            <div className="session-item-text">
              <div className="session-item-title">{s.title || s.id}</div>
              <div className="session-item-time">{relativeTime(s.updated_at ?? s.created_at)}</div>
            </div>
            <button
              className="item-delete"
              title="刪除"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </nav>
      <button className="settings-btn" onClick={onOpenSettings}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        設定
      </button>
    </aside>
  );
}
