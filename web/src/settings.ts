import { useSyncExternalStore } from "react";

// 所有設定都只存在這個瀏覽器的 localStorage，不會送到 pi-claude 的伺服器。
export interface Settings {
  apiKey: string;
  /** 空字串代表走同源的 /anthropic 轉送；也可以填 https://api.anthropic.com 直連。 */
  baseUrl: string;
  /** Console 連結用的 workspace ID；Default workspace 留空即可。 */
  workspaceId: string;
  agentId: string;
  environmentId: string;
  /** 新對話預設掛載的 GitHub repo。 */
  repoUrl: string;
  repoBranch: string;
  githubToken: string;
  /** 每個 session 的花費上限（美元），空字串代表不設。 */
  budgetUsd: string;
}

const KEY = "pi-claude.settings.v1";

const DEFAULTS: Settings = {
  apiKey: "",
  baseUrl: "",
  workspaceId: "",
  agentId: "",
  environmentId: "",
  repoUrl: "",
  repoBranch: "",
  githubToken: "",
  budgetUsd: "",
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // 私密模式或被封鎖的 storage：用預設值
  }
  return { ...DEFAULTS };
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 存不了就只留在記憶體
  }
  for (const l of listeners) l();
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function isConfigured(s: Settings): boolean {
  return Boolean(s.apiKey && s.agentId && s.environmentId);
}
