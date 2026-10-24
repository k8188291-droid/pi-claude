import Anthropic from "@anthropic-ai/sdk";
import type { Settings } from "./settings";

export type Session = Anthropic.Beta.Sessions.BetaManagedAgentsSession;
export type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
export type StreamEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;
export type Agent = Anthropic.Beta.Agents.BetaManagedAgentsAgent;
export type Environment = Anthropic.Beta.Environments.BetaEnvironment;
export type ToolUseEvent =
  | Anthropic.Beta.Sessions.BetaManagedAgentsAgentToolUseEvent
  | Anthropic.Beta.Sessions.BetaManagedAgentsAgentMCPToolUseEvent
  | Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent;
export type ToolResultEvent =
  | Anthropic.Beta.Sessions.BetaManagedAgentsAgentToolResultEvent
  | Anthropic.Beta.Sessions.BetaManagedAgentsAgentMCPToolResultEvent;

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
] as const;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const TOOL_NAMES = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type PermissionPolicy = "auto" | "always_allow" | "always_ask";

/** 這個 app 建立的 session 都帶這個 metadata，方便辨識。 */
export const APP_METADATA = { created_by: "pi-claude-web" };

let cached: { key: string; client: Anthropic } | undefined;

export function getClient(s: Settings): Anthropic {
  const baseURL = s.baseUrl.trim() || `${window.location.origin}/anthropic`;
  const key = `${s.apiKey}\n${baseURL}`;
  if (cached?.key !== key) {
    cached = {
      key,
      client: new Anthropic({
        apiKey: s.apiKey,
        baseURL,
        // key 由使用者自己輸入、只存在自己的瀏覽器，所以在瀏覽器端使用 SDK 是刻意的。
        dangerouslyAllowBrowser: true,
      }),
    };
  }
  return cached.client;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "API key 無效（401）";
  if (err instanceof Anthropic.PermissionDeniedError) return `權限不足（403）：${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `找不到資源（404）：${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "請求太頻繁（429），稍後再試";
  if (err instanceof Anthropic.APIError) return `API 錯誤 ${err.status ?? ""}：${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isAbort(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === "AbortError");
}

export function consoleSessionUrl(s: Settings, sessionId: string): string {
  return `https://platform.claude.com/workspaces/${s.workspaceId.trim() || "default"}/sessions/${sessionId}`;
}

/** "2500"（美分）→ "$25.00" */
export function formatCost(amount: { amount: string; currency: string } | null | undefined): string {
  if (!amount) return "";
  const cents = Number(amount.amount);
  if (!Number.isFinite(cents)) return "";
  return `$${(cents / 100).toFixed(2)}`;
}

/** "25" / "2.5" 美元 → "2500" / "250" 美分字串；空或無效時回傳 undefined。 */
export function usdToCents(usd: string): string | undefined {
  const n = Number(usd.trim());
  if (!usd.trim() || !Number.isFinite(n) || n <= 0) return undefined;
  return String(Math.round(n * 100));
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent working in a sandboxed Linux container. " +
  "Repositories the user attached are cloned under /workspace. " +
  "Make focused changes, run the project's checks before saying you are done, and summarize what you changed. " +
  "Write files the user should download to /mnt/session/outputs/.";
