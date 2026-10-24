import { useEffect, useRef, useState } from "react";
import { consoleSessionUrl, errorMessage, formatCost, getClient } from "../api";
import type { Settings } from "../settings";
import { useSession } from "../useSession";
import { Composer } from "./Composer";
import { Timeline } from "./Timeline";

interface Props {
  settings: Settings;
  sessionId: string;
  onSessionChanged: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  running: "執行中",
  idle: "閒置",
  rescheduling: "重新排程",
  terminated: "已結束",
};

export function SessionView({ settings, sessionId, onSessionChanged }: Props) {
  const { state, sendMessage, dismissPending, interrupt, confirmTool, rejectCustomTool } = useSession(
    settings,
    sessionId,
  );
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showFiles, setShowFiles] = useState(false);

  // 使用者停在底部時才自動捲動，往上看歷史時不打擾。
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // 狀態變化（例如 idle）時更新側欄。
  useEffect(() => {
    if (state.status) onSessionChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  const waitingOnApproval = state.status === "idle" && state.stopReason?.type === "requires_action";
  const budgetPaused = state.status === "idle" && state.stopReason?.type === "budget_reached";
  const terminated = state.status === "terminated";
  const running = state.status === "running" || state.status === "rescheduling";

  let disabledReason: string | undefined;
  if (terminated) disabledReason = "這個 session 已結束，請開新對話";
  else if (waitingOnApproval) disabledReason = "請先回應上方的工具核准要求";
  else if (budgetPaused) disabledReason = "已達花費上限；到 Console 調高預算後才能繼續";

  return (
    <div className="session-view">
      <header className="session-header">
        <div className="session-title">
          <h1>{state.session?.title || sessionId}</h1>
          <div className="session-sub">
            {state.status && <span className={`badge ${state.status}`}>{STATUS_LABEL[state.status]}</span>}
            {state.cost && <span className="cost">{formatCost(state.cost)}</span>}
            {state.connection === "reconnecting" && <span className="badge warn">重新連線中…</span>}
            {state.error && state.connection !== "live" && <span className="header-error">{state.error}</span>}
          </div>
        </div>
        <div className="session-actions">
          <button className="btn ghost" onClick={() => setShowFiles((v) => !v)}>
            輸出檔案
          </button>
          <a className="btn ghost" href={consoleSessionUrl(settings, sessionId)} target="_blank" rel="noreferrer">
            Console ↗
          </a>
        </div>
      </header>
      {showFiles && <OutputFiles settings={settings} sessionId={sessionId} onClose={() => setShowFiles(false)} />}
      <div
        className="scroller"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {state.order.length === 0 && state.connection === "connecting" ? (
          <div className="empty">載入中…</div>
        ) : (
          <Timeline
            state={state}
            onConfirm={confirmTool}
            onRejectCustomTool={rejectCustomTool}
            onDismissPending={dismissPending}
          />
        )}
      </div>
      <Composer
        disabled={Boolean(disabledReason)}
        disabledReason={disabledReason}
        running={running}
        placeholder={running ? "可以繼續輸入，訊息會排在目前工作之後" : undefined}
        onSend={sendMessage}
        onInterrupt={() => void interrupt()}
      />
    </div>
  );
}

function OutputFiles({ settings, sessionId, onClose }: { settings: Settings; sessionId: string; onClose: () => void }) {
  const [files, setFiles] = useState<{ id: string; filename: string; size_bytes: number }[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list: { id: string; filename: string; size_bytes: number }[] = [];
        // scope_id 篩選需要 managed-agents beta header，beta.files 不會自動帶。
        for await (const f of getClient(settings).beta.files.list({
          scope_id: sessionId,
          betas: ["managed-agents-2026-04-01"],
        })) {
          list.push(f);
        }
        if (!cancelled) setFiles(list);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings, sessionId]);

  const download = async (id: string, filename: string) => {
    try {
      const res = await getClient(settings).beta.files.download(id);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="files-panel">
      <div className="files-head">
        <span>/mnt/session/outputs/</span>
        <button className="link" onClick={onClose}>
          關閉
        </button>
      </div>
      {error && <div className="field-error">{error}</div>}
      {!files && !error && <div className="muted">載入中…</div>}
      {files?.length === 0 && <div className="muted">還沒有輸出檔案。Agent 寫到 /mnt/session/outputs/ 的檔案會出現在這裡。</div>}
      {files?.map((f) => (
        <div className="file-row" key={f.id}>
          <span className="file-name">{f.filename}</span>
          <span className="muted">{(f.size_bytes / 1024).toFixed(1)} KB</span>
          <button className="link" onClick={() => download(f.id, f.filename)}>
            下載
          </button>
        </div>
      ))}
    </div>
  );
}
