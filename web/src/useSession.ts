import { useCallback, useEffect, useReducer, useRef } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import { errorMessage, getClient, isAbort, type Session, type SessionEvent, type StreamEvent } from "./api";
import type { Settings } from "./settings";

type IdleStopReason = Anthropic.Beta.Sessions.BetaManagedAgentsSessionStatusIdleEvent["stop_reason"];
type Money = { amount: string; currency: string };

export interface PendingMessage {
  localId: string;
  text: string;
  failed?: string;
}

export interface SessionState {
  session?: Session;
  /** 依抵達順序排列的事件 id；同一個 id 的後到版本（例如 processed_at 補上）會覆蓋內容但保留位置。 */
  order: string[];
  byId: Record<string, SessionEvent>;
  /** 還在生成中的 agent.message 預覽：event id → 每個 content index 的文字。 */
  previews: Record<string, string[]>;
  thinking: boolean;
  status?: Session["status"];
  stopReason?: IdleStopReason;
  cost?: Money | null;
  pending: PendingMessage[];
  connection: "connecting" | "live" | "reconnecting" | "closed";
  error?: string;
}

type Action =
  | { type: "reset" }
  | { type: "session"; session: Session }
  | { type: "event"; event: StreamEvent }
  | { type: "connection"; connection: SessionState["connection"]; error?: string }
  | { type: "pending_add"; msg: PendingMessage }
  | { type: "pending_remove"; localId: string }
  | { type: "pending_fail"; localId: string; error: string };

const INITIAL: SessionState = {
  order: [],
  byId: {},
  previews: {},
  thinking: false,
  pending: [],
  connection: "connecting",
};

// interrupt 事件的 id 有時是空字串，用型別和時間組出穩定的 key。
function eventKey(e: SessionEvent): string {
  return e.id || `${e.type}@${"processed_at" in e ? (e.processed_at ?? "") : ""}`;
}

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "reset":
      return INITIAL;
    case "session":
      return {
        ...state,
        session: action.session,
        status: state.status ?? action.session.status,
        cost: state.cost ?? action.session.usage?.list_cost ?? null,
      };
    case "connection":
      return { ...state, connection: action.connection, error: action.error };
    case "pending_add":
      return { ...state, pending: [...state.pending, action.msg] };
    case "pending_remove":
      return { ...state, pending: state.pending.filter((p) => p.localId !== action.localId) };
    case "pending_fail":
      return {
        ...state,
        pending: state.pending.map((p) => (p.localId === action.localId ? { ...p, failed: action.error } : p)),
      };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: SessionState, ev: StreamEvent): SessionState {
  // 只在串流上出現的預覽事件，不會持久化。
  if (ev.type === "event_start") {
    if (ev.event.type === "agent.thinking") return { ...state, thinking: true };
    if (state.byId[ev.event.id]) return state;
    return { ...state, previews: { ...state.previews, [ev.event.id]: [] } };
  }
  if (ev.type === "event_delta") {
    if (state.byId[ev.event_id]) return state; // 正式事件已經到了
    const parts = [...(state.previews[ev.event_id] ?? [])];
    const i = ev.delta.index ?? 0;
    parts[i] = (parts[i] ?? "") + ev.delta.content.text;
    return { ...state, previews: { ...state.previews, [ev.event_id]: parts } };
  }

  const key = eventKey(ev);
  const next: SessionState = {
    ...state,
    byId: { ...state.byId, [key]: ev },
    order: state.byId[key] ? state.order : [...state.order, key],
  };

  switch (ev.type) {
    case "agent.message": {
      if (next.previews[ev.id]) {
        const { [ev.id]: _done, ...rest } = next.previews;
        next.previews = rest;
      }
      break;
    }
    case "agent.thinking":
      next.thinking = false;
      break;
    case "span.model_request_end": {
      // 被中斷或出錯的請求不會有正式的 agent.message；收掉殘留的預覽。
      next.previews = {};
      next.thinking = false;
      break;
    }
    case "session.status_running":
      next.status = "running";
      next.stopReason = undefined;
      break;
    case "session.status_rescheduled":
      next.status = "rescheduling";
      break;
    case "session.status_idle":
      next.status = "idle";
      next.stopReason = ev.stop_reason;
      next.thinking = false;
      break;
    case "session.status_terminated":
      next.status = "terminated";
      next.thinking = false;
      break;
    case "session.usage":
      next.cost = ev.usage.list_cost ?? next.cost;
      break;
    case "session.updated":
      if (next.session && "title" in ev && typeof ev.title === "string") {
        next.session = { ...next.session, title: ev.title };
      }
      break;
  }
  return next;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * 連上一個 session：先開 SSE 串流，再抓完整歷史並以 event id 去重（串流沒有重播，
 * 這樣斷線重連也不會漏事件）。串流斷掉時自動重連，直到 session terminated。
 */
export function useSession(settings: Settings, sessionId: string | undefined) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const statusRef = useRef<SessionState["status"]>(undefined);
  statusRef.current = state.status;

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!sessionId || !settings.apiKey) return;
    const client = getClient(settings);
    const ac = new AbortController();

    client.beta.sessions
      .retrieve(sessionId, undefined, { signal: ac.signal })
      .then((session) => dispatch({ type: "session", session }))
      .catch((err) => {
        if (!isAbort(err)) dispatch({ type: "connection", connection: "closed", error: errorMessage(err) });
      });

    (async () => {
      let attempt = 0;
      while (!ac.signal.aborted) {
        try {
          dispatch({ type: "connection", connection: attempt === 0 ? "connecting" : "reconnecting" });
          const stream = await client.beta.sessions.events.stream(
            sessionId,
            { event_deltas: ["agent.message", "agent.thinking"] },
            { signal: ac.signal },
          );
          for await (const ev of client.beta.sessions.events.list(sessionId, { limit: 1000 }, { signal: ac.signal })) {
            dispatch({ type: "event", event: ev });
          }
          dispatch({ type: "connection", connection: "live" });
          attempt = 0;
          for await (const ev of stream) {
            dispatch({ type: "event", event: ev });
          }
        } catch (err) {
          if (ac.signal.aborted || isAbort(err)) return;
          dispatch({ type: "connection", connection: "reconnecting", error: errorMessage(err) });
        }
        if (statusRef.current === "terminated") {
          dispatch({ type: "connection", connection: "closed" });
          return;
        }
        attempt++;
        await sleep(Math.min(1000 * 2 ** attempt, 15000), ac.signal);
      }
    })();

    return () => ac.abort();
    // settings 物件每次更新都會換；只在 key / 位址變動時重連。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, settings.apiKey, settings.baseUrl]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      dispatch({ type: "pending_add", msg: { localId, text } });
      try {
        const res = await getClient(settings).beta.sessions.events.send(sessionId, {
          events: [{ type: "user.message", content: [{ type: "text", text }] }],
        });
        for (const ev of res.data ?? []) dispatch({ type: "event", event: ev });
        dispatch({ type: "pending_remove", localId });
      } catch (err) {
        dispatch({ type: "pending_fail", localId, error: errorMessage(err) });
      }
    },
    [sessionId, settings],
  );

  const dismissPending = useCallback((localId: string) => dispatch({ type: "pending_remove", localId }), []);

  const interrupt = useCallback(async () => {
    if (!sessionId) return;
    await getClient(settings).beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
  }, [sessionId, settings]);

  const confirmTool = useCallback(
    async (toolUseEventId: string, result: "allow" | "deny", denyMessage?: string) => {
      if (!sessionId) return;
      const res = await getClient(settings).beta.sessions.events.send(sessionId, {
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: toolUseEventId,
            result,
            ...(result === "deny" && denyMessage ? { deny_message: denyMessage } : {}),
          },
        ],
      });
      for (const ev of res.data ?? []) dispatch({ type: "event", event: ev });
    },
    [sessionId, settings],
  );

  /** 這個 app 沒有定義 custom tool；若 agent 呼叫了，回報錯誤讓它繼續。 */
  const rejectCustomTool = useCallback(
    async (customToolUseId: string) => {
      if (!sessionId) return;
      await getClient(settings).beta.sessions.events.send(sessionId, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: customToolUseId,
            is_error: true,
            content: [{ type: "text", text: "This client does not implement custom tools." }],
          },
        ],
      });
    },
    [sessionId, settings],
  );

  return { state, sendMessage, dismissPending, interrupt, confirmTool, rejectCustomTool };
}
