import { useCallback, useEffect, useState } from "react";
import { errorMessage, getClient, type Session } from "./api";
import { NewSession } from "./components/NewSession";
import { SessionView } from "./components/SessionView";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { useSettings } from "./settings";

function sessionFromHash(): string | undefined {
  const m = window.location.hash.match(/^#\/s\/([\w-]+)/);
  return m?.[1];
}

export function App() {
  const settings = useSettings();
  const [activeId, setActiveId] = useState<string | undefined>(sessionFromHash);
  const [sessions, setSessions] = useState<Session[]>();
  const [listError, setListError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(() => !settings.apiKey);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setActiveId(sessionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = (id: string | undefined) => {
    window.location.hash = id ? `/s/${id}` : "";
    setActiveId(id);
    setSidebarOpen(false);
  };

  const refresh = useCallback(async () => {
    if (!settings.apiKey) {
      setSessions(undefined);
      return;
    }
    setLoading(true);
    try {
      const page = await getClient(settings).beta.sessions.list({ limit: 50, order: "desc" });
      setSessions(page.data);
      setListError(undefined);
    } catch (err) {
      setListError(errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKey, settings.baseUrl]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const remove = async (s: Session) => {
    if (!window.confirm(`永久刪除「${s.title || s.id}」？對話紀錄和容器都會一起刪除，無法復原。`)) return;
    try {
      await getClient(settings).beta.sessions.delete(s.id);
      if (s.id === activeId) select(undefined);
      await refresh();
    } catch (err) {
      window.alert(`刪除失敗：${errorMessage(err)}`);
    }
  };

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>
      <button className="menu-btn" onClick={() => setSidebarOpen((o) => !o)} aria-label="切換側欄">
        ☰
      </button>
      <Sidebar
        sessions={sessions}
        loading={loading}
        error={listError}
        activeId={activeId}
        onNew={() => select(undefined)}
        onSelect={select}
        onDelete={remove}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefresh={() => void refresh()}
      />
      <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
      <main className="main">
        {activeId ? (
          <SessionView key={activeId} settings={settings} sessionId={activeId} onSessionChanged={() => void refresh()} />
        ) : (
          <NewSession
            settings={settings}
            onOpenSettings={() => setSettingsOpen(true)}
            onCreated={(s) => {
              setSessions((prev) => [s, ...(prev ?? []).filter((x) => x.id !== s.id)]);
              select(s.id);
            }}
          />
        )}
      </main>
      {settingsOpen && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
