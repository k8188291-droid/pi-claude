import { memo, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SessionEvent, ToolResultEvent, ToolUseEvent } from "../api";
import type { PendingMessage, SessionState } from "../useSession";

interface Props {
  state: SessionState;
  onConfirm: (toolUseEventId: string, result: "allow" | "deny", denyMessage?: string) => Promise<void>;
  onRejectCustomTool: (id: string) => Promise<void>;
  onDismissPending: (localId: string) => void;
}

type ToolConfirmation = Extract<SessionEvent, { type: "user.tool_confirmation" }>;

export function Timeline({ state, onConfirm, onRejectCustomTool, onDismissPending }: Props) {
  // 工具結果和確認都畫在對應的工具卡片裡，先建索引。
  const { results, confirmations, customAnswered } = useMemo(() => {
    const results: Record<string, ToolResultEvent> = {};
    const confirmations: Record<string, ToolConfirmation> = {};
    const customAnswered = new Set<string>();
    for (const id of state.order) {
      const ev = state.byId[id];
      if (ev.type === "agent.tool_result") results[ev.tool_use_id] = ev;
      else if (ev.type === "agent.mcp_tool_result") results[ev.mcp_tool_use_id] = ev;
      else if (ev.type === "user.tool_confirmation") confirmations[ev.tool_use_id] = ev;
      else if (ev.type === "user.custom_tool_result") customAnswered.add(ev.custom_tool_use_id);
    }
    return { results, confirmations, customAnswered };
  }, [state.order, state.byId]);

  const items = state.order.map((id) => {
    const ev = state.byId[id];
    switch (ev.type) {
      case "user.message":
        return <UserBubble key={id} text={textOf(ev.content)} queued={!ev.processed_at} />;
      case "agent.message":
        return <AgentText key={id} text={textOf(ev.content)} />;
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        return (
          <ToolCard
            key={id}
            ev={ev}
            result={results[ev.id]}
            confirmation={confirmations[ev.id]}
            onConfirm={onConfirm}
          />
        );
      case "agent.custom_tool_use":
        return (
          <ToolCard
            key={id}
            ev={ev}
            customPending={!customAnswered.has(ev.id)}
            onRejectCustomTool={onRejectCustomTool}
          />
        );
      case "session.error":
        return (
          <Notice key={id} tone="error">
            {ev.error.type}：{ev.error.message}
          </Notice>
        );
      case "user.interrupt":
        return <Notice key={id}>已中斷</Notice>;
      case "agent.thread_context_compacted":
        return <Notice key={id}>對話內容已壓縮以節省 context</Notice>;
      case "session.status_idle":
        if (ev.stop_reason.type === "retries_exhausted")
          return (
            <Notice key={id} tone="error">
              重試次數用盡，這一輪失敗
            </Notice>
          );
        if (ev.stop_reason.type === "budget_reached")
          return (
            <Notice key={id} tone="warn">
              已達這個 session 的花費上限，已暫停
            </Notice>
          );
        if (ev.stop_reason.type === "refusal")
          return (
            <Notice key={id} tone="warn">
              模型拒絕了這個請求{ev.stop_details?.explanation ? `：${ev.stop_details.explanation}` : ""}
            </Notice>
          );
        return null;
      case "session.status_terminated":
        return <Notice key={id}>Session 已結束</Notice>;
      default:
        return null;
    }
  });

  return (
    <div className="timeline">
      {items}
      {Object.entries(state.previews).map(([id, parts]) =>
        parts.join("") ? <AgentText key={`preview-${id}`} text={parts.join("")} streaming /> : null,
      )}
      {state.pending.map((p) => (
        <PendingBubble key={p.localId} msg={p} onDismiss={onDismissPending} />
      ))}
      {(state.status === "running" || state.status === "rescheduling") && (
        <div className="working">
          <span className="spinner" />
          {state.status === "rescheduling" ? "重新排程中…" : state.thinking ? "思考中…" : "工作中…"}
        </div>
      )}
    </div>
  );
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");
}

function UserBubble({ text, queued }: { text: string; queued?: boolean }) {
  return (
    <div className={`msg user${queued ? " queued" : ""}`}>
      <div className="bubble">{text}</div>
      {queued && <div className="msg-meta">排隊中</div>}
    </div>
  );
}

function PendingBubble({ msg, onDismiss }: { msg: PendingMessage; onDismiss: (id: string) => void }) {
  return (
    <div className={`msg user ${msg.failed ? "failed" : "queued"}`}>
      <div className="bubble">{msg.text}</div>
      <div className="msg-meta">
        {msg.failed ? (
          <>
            送出失敗：{msg.failed}{" "}
            <button className="link" onClick={() => onDismiss(msg.localId)}>
              移除
            </button>
          </>
        ) : (
          "傳送中…"
        )}
      </div>
    </div>
  );
}

const AgentText = memo(function AgentText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`msg agent${streaming ? " streaming" : ""}`}>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </div>
  );
});

function Notice({ children, tone }: { children: React.ReactNode; tone?: "error" | "warn" }) {
  return <div className={`notice${tone ? ` ${tone}` : ""}`}>{children}</div>;
}

const TOOL_LABELS: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  web_fetch: "Fetch",
  web_search: "Search",
};

function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  const s =
    (name === "bash" && pick("command")) ||
    pick("file_path") ||
    pick("pattern") ||
    pick("url") ||
    pick("query") ||
    pick("path") ||
    "";
  return s.split("\n")[0];
}

function ToolCard({
  ev,
  result,
  confirmation,
  customPending,
  onConfirm,
  onRejectCustomTool,
}: {
  ev: ToolUseEvent;
  result?: ToolResultEvent;
  confirmation?: ToolConfirmation;
  customPending?: boolean;
  onConfirm?: Props["onConfirm"];
  onRejectCustomTool?: Props["onRejectCustomTool"];
}) {
  const needsApproval =
    ev.type !== "agent.custom_tool_use" && ev.evaluated_permission === "ask" && !confirmation && !result;
  const autoDenied = ev.type !== "agent.custom_tool_use" && ev.evaluated_permission === "deny";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const label =
    ev.type === "agent.mcp_tool_use" ? `${ev.mcp_server_name} · ${ev.name}` : (TOOL_LABELS[ev.name] ?? ev.name);
  const summary = toolSummary(ev.name, ev.input);

  let state: "running" | "ok" | "error" | "ask" | "denied" = "running";
  if (needsApproval || customPending) state = "ask";
  else if (autoDenied || confirmation?.result === "deny") state = "denied";
  else if (result) state = result.is_error ? "error" : "ok";

  const decide = async (r: "allow" | "deny") => {
    if (!onConfirm) return;
    setBusy(true);
    setErr(undefined);
    try {
      await onConfirm(ev.id, r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resultText = result ? textOf(result.content ?? []) : "";
  const inputText =
    ev.name === "bash" && typeof ev.input.command === "string"
      ? ev.input.command
      : JSON.stringify(ev.input, null, 2);

  return (
    <div className={`tool ${state}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className={`dot ${state}`} />
        <span className="tool-name">{label}</span>
        <span className="tool-summary">{summary}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section-label">Input</div>
          <pre>{inputText}</pre>
          {result && (
            <>
              <div className="tool-section-label">{result.is_error ? "Error" : "Output"}</div>
              <pre className={result.is_error ? "err" : ""}>{resultText || "(no output)"}</pre>
            </>
          )}
          {ev.type !== "agent.custom_tool_use" && ev.evaluation && (
            <div className="tool-eval">權限評估：{JSON.stringify(ev.evaluation)}</div>
          )}
        </div>
      )}
      {needsApproval && (
        <div className="approval">
          <span>Agent 想執行這個工具，要允許嗎？</span>
          <div className="approval-actions">
            <button className="btn danger" disabled={busy} onClick={() => decide("deny")}>
              拒絕
            </button>
            <button className="btn primary" disabled={busy} onClick={() => decide("allow")}>
              允許
            </button>
          </div>
          {err && <div className="field-error">{err}</div>}
        </div>
      )}
      {customPending && onRejectCustomTool && (
        <div className="approval">
          <span>Agent 呼叫了自訂工具，但這個介面沒有實作。</span>
          <div className="approval-actions">
            <button className="btn" onClick={() => onRejectCustomTool(ev.id)}>
              回報錯誤並繼續
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
