import { useState } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import { APP_METADATA, errorMessage, getClient, usdToCents, type Session } from "../api";
import { isConfigured, type Settings } from "../settings";
import { Composer } from "./Composer";

interface Props {
  settings: Settings;
  onCreated: (session: Session) => void;
  onOpenSettings: () => void;
}

type Resource = Anthropic.Beta.Sessions.BetaManagedAgentsGitHubRepositoryResourceParams;

export function NewSession({ settings, onCreated, onOpenSettings }: Props) {
  const [repoUrl, setRepoUrl] = useState(settings.repoUrl);
  const [branch, setBranch] = useState(settings.repoBranch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = isConfigured(settings);

  const start = async (text: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const resources: Resource[] = [];
      if (repoUrl.trim()) {
        resources.push({
          type: "github_repository",
          url: repoUrl.trim(),
          ...(settings.githubToken ? { authorization_token: settings.githubToken } : {}),
          ...(branch.trim() ? { checkout: { type: "branch" as const, name: branch.trim() } } : {}),
        });
      }
      const cents = usdToCents(settings.budgetUsd);
      // initial_events 讓建立 session 和第一則訊息在同一個請求完成；
      // 接著 SessionView 會先開串流再補抓歷史，不會漏掉建立後馬上產生的事件。
      const session = await getClient(settings).beta.sessions.create({
        agent: settings.agentId,
        environment_id: settings.environmentId,
        title: text.split("\n")[0].slice(0, 80),
        metadata: APP_METADATA,
        ...(resources.length ? { resources } : {}),
        ...(cents ? { budget: { type: "limit" as const, max_list_cost: { amount: cents, currency: "USD" as const } } } : {}),
        initial_events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
      onCreated(session);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="session-view new-session">
      <div className="scroller">
        <div className="hero">
          <h1>今天要做什麼？</h1>
          {!ready ? (
            <div className="setup-hint">
              <p>開始之前，先設定 API key，並選擇（或建立）要使用的 agent 與 environment。</p>
              <button className="btn primary" onClick={onOpenSettings}>
                開啟設定
              </button>
            </div>
          ) : (
            <p className="muted">每則新對話都是一個 Managed Agents session，在獨立的雲端容器裡執行。</p>
          )}
          {error && <div className="field-error">{error}</div>}
        </div>
      </div>
      <Composer
        disabled={!ready || busy}
        disabledReason={!ready ? "請先完成設定" : "建立 session 中…"}
        placeholder="描述你要 agent 做的事，Enter 送出"
        onSend={start}
      >
        <div className="repo-row">
          <label>
            <span>GitHub repo</span>
            <input
              value={repoUrl}
              placeholder="https://github.com/owner/repo（選填）"
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </label>
          <label className="branch">
            <span>分支</span>
            <input value={branch} placeholder="預設分支" onChange={(e) => setBranch(e.target.value)} />
          </label>
        </div>
      </Composer>
    </div>
  );
}
