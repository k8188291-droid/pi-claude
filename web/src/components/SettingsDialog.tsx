import { useCallback, useEffect, useState } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_SYSTEM_PROMPT,
  EFFORTS,
  MODELS,
  TOOL_NAMES,
  errorMessage,
  getClient,
  type Agent,
  type Environment,
  type PermissionPolicy,
  type ToolName,
} from "../api";
import { updateSettings, type Settings } from "../settings";

type Tab = "api" | "agent" | "environment" | "session";

interface Props {
  settings: Settings;
  onClose: () => void;
}

export function SettingsDialog({ settings, onClose }: Props) {
  const [tab, setTab] = useState<Tab>(settings.apiKey ? "agent" : "api");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="設定">
        <header className="modal-head">
          <h2>設定</h2>
          <button className="link close" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <nav className="tabs">
          {(
            [
              ["api", "API Key"],
              ["agent", "Agent"],
              ["environment", "Environment"],
              ["session", "新對話預設"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={`tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="modal-body">
          {tab === "api" && <ApiTab settings={settings} onNext={() => setTab("agent")} />}
          {tab === "agent" && <AgentTab settings={settings} />}
          {tab === "environment" && <EnvironmentTab settings={settings} />}
          {tab === "session" && <SessionDefaultsTab settings={settings} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- API

function ApiTab({ settings, onNext }: { settings: Settings; onNext: () => void }) {
  const [key, setKey] = useState(settings.apiKey);
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    updateSettings({ apiKey: key.trim() });
    setBusy(true);
    setStatus(undefined);
    try {
      await getClient({ ...settings, apiKey: key.trim() }).beta.agents.list({ limit: 1 });
      setStatus({ ok: true, text: "連線成功，已儲存。" });
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form">
      <p className="muted">
        到 <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">Claude Console</a>{" "}
        建立 API key。Key 只存在這個瀏覽器的 localStorage，透過本服務的 /anthropic 轉送到 Anthropic API，伺服器不會保存。
      </p>
      <label className="field">
        <span>Anthropic API Key</span>
        <div className="input-row">
          <input
            type={show ? "text" : "password"}
            value={key}
            autoComplete="off"
            placeholder="sk-ant-..."
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="btn ghost" onClick={() => setShow((s) => !s)}>
            {show ? "隱藏" : "顯示"}
          </button>
        </div>
      </label>
      <div className="row">
        <button className="btn primary" disabled={!key.trim() || busy} onClick={save}>
          {busy ? "測試中…" : "儲存並測試連線"}
        </button>
        {status?.ok && (
          <button className="btn" onClick={onNext}>
            下一步：設定 Agent →
          </button>
        )}
      </div>
      {status && <div className={status.ok ? "field-ok" : "field-error"}>{status.text}</div>}

      <details className="advanced">
        <summary>進階</summary>
        <label className="field">
          <span>Workspace ID（Console 連結用；Default workspace 留空）</span>
          <input
            value={settings.workspaceId}
            placeholder="default"
            onChange={(e) => updateSettings({ workspaceId: e.target.value })}
          />
        </label>
        <label className="field">
          <span>API 位址（留空使用本服務的轉送 /anthropic）</span>
          <input
            value={settings.baseUrl}
            placeholder={`${window.location.origin}/anthropic`}
            onChange={(e) => updateSettings({ baseUrl: e.target.value })}
          />
        </label>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- Agent

interface AgentForm {
  name: string;
  model: string;
  effort: string;
  system: string;
  policy: PermissionPolicy;
  tools: Record<ToolName, boolean>;
}

const NEW_AGENT_FORM: AgentForm = {
  name: "pi-claude coding agent",
  model: "claude-opus-5-5",
  effort: "high",
  system: DEFAULT_SYSTEM_PROMPT,
  policy: "auto",
  tools: { bash: true, read: true, write: true, edit: true, glob: true, grep: true, web_fetch: false, web_search: false },
};

type ToolConfigLike = { name: string; enabled?: boolean | null; permission_policy?: { type: string } | null };
type AgentToolset = Anthropic.Beta.Agents.BetaManagedAgentsAgentToolset20260401;

function toolsetOf(agent: Agent): AgentToolset | undefined {
  return agent.tools.find((t): t is AgentToolset => t.type === "agent_toolset_20260401");
}

function formFromAgent(agent: Agent): AgentForm {
  const toolset = toolsetOf(agent);
  const defaultEnabled = toolset?.default_config.enabled ?? true;
  const configs = (toolset?.configs ?? []) as ToolConfigLike[];
  const tools = Object.fromEntries(
    TOOL_NAMES.map((n) => [n, configs.find((c) => c.name === n)?.enabled ?? defaultEnabled]),
  ) as Record<ToolName, boolean>;
  const effort = agent.model.effort;
  return {
    name: agent.name,
    model: agent.model.id,
    effort: typeof effort === "string" ? effort : (effort?.type ?? ""),
    system: agent.system ?? "",
    policy: (toolset?.default_config.permission_policy.type as PermissionPolicy) ?? "always_allow",
    tools,
  };
}

function buildTools(form: AgentForm, existing?: Agent) {
  // 保留既有 agent 的每個工具自訂權限，以及 MCP / custom 等其他工具。
  const prevConfigs = ((existing && toolsetOf(existing)?.configs) ?? []) as ToolConfigLike[];
  const toolset: Anthropic.Beta.Agents.BetaManagedAgentsAgentToolset20260401Params = {
    type: "agent_toolset_20260401",
    default_config: { enabled: true, permission_policy: { type: form.policy } },
    configs: TOOL_NAMES.map((name) => {
      const prev = prevConfigs.find((c) => c.name === name);
      return {
        name,
        enabled: form.tools[name],
        ...(prev?.permission_policy ? { permission_policy: prev.permission_policy } : {}),
      } as Anthropic.Beta.Agents.BetaManagedAgentsAgentToolConfigParams;
    }),
  };
  const others = (existing?.tools ?? []).filter((t) => t.type !== "agent_toolset_20260401");
  return [toolset, ...others] as Anthropic.Beta.Agents.AgentCreateParams["tools"];
}

function AgentTab({ settings }: { settings: Settings }) {
  const [agents, setAgents] = useState<Agent[]>();
  const [selected, setSelected] = useState<string>(settings.agentId || "new");
  const [form, setForm] = useState<AgentForm>(NEW_AGENT_FORM);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const load = useCallback(async () => {
    try {
      const list: Agent[] = [];
      for await (const a of getClient(settings).beta.agents.list({ limit: 100 })) list.push(a);
      setAgents(list);
      return list;
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKey, settings.baseUrl]);

  useEffect(() => {
    if (!settings.apiKey) return;
    void load().then((list) => {
      const current = list.find((a) => a.id === settings.agentId);
      if (current) setForm(formFromAgent(current));
      else setSelected("new");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  if (!settings.apiKey) return <p className="muted">請先在「API Key」分頁設定 API key。</p>;

  const existing = agents?.find((a) => a.id === selected);

  const choose = (id: string) => {
    setSelected(id);
    setMsg(undefined);
    const a = agents?.find((x) => x.id === id);
    if (a) {
      setForm(formFromAgent(a));
      updateSettings({ agentId: a.id });
    } else {
      setForm(NEW_AGENT_FORM);
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg(undefined);
    const client = getClient(settings);
    const model = { id: form.model, ...(form.effort ? { effort: form.effort as (typeof EFFORTS)[number] } : {}) };
    try {
      let saved: Agent;
      if (existing) {
        saved = await client.beta.agents.update(existing.id, {
          version: existing.version,
          name: form.name,
          model,
          system: form.system || null,
          tools: buildTools(form, existing),
        });
      } else {
        saved = await client.beta.agents.create({
          name: form.name,
          model,
          system: form.system || null,
          tools: buildTools(form),
          metadata: { created_by: "pi-claude-web" },
        });
      }
      updateSettings({ agentId: saved.id });
      setSelected(saved.id);
      await load();
      setMsg({ ok: true, text: `已儲存 ${saved.id}（version ${saved.version}），新對話會使用這個 agent。` });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof AgentForm>(k: K, v: AgentForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="form">
      <label className="field">
        <span>使用的 Agent</span>
        <select value={selected} onChange={(e) => choose(e.target.value)}>
          <option value="new">＋ 建立新的 agent</option>
          {agents?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}（{a.model.id}，v{a.version}）
            </option>
          ))}
        </select>
      </label>
      {existing && (
        <p className="muted small">
          {existing.id}。修改後儲存會建立新版本（v{existing.version + 1}），進行中的 session 仍使用原版本。
        </p>
      )}

      <label className="field">
        <span>名稱</span>
        <input value={form.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <div className="grid2">
        <label className="field">
          <span>模型</span>
          <select value={form.model} onChange={(e) => set("model", e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {!MODELS.some((m) => m.id === form.model) && <option value={form.model}>{form.model}</option>}
          </select>
        </label>
        <label className="field">
          <span>Effort</span>
          <select value={form.effort} onChange={(e) => set("effort", e.target.value)}>
            <option value="">模型預設</option>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>System prompt</span>
        <textarea rows={5} value={form.system} onChange={(e) => set("system", e.target.value)} />
      </label>

      <fieldset className="field">
        <legend>內建工具（agent_toolset_20260401）</legend>
        <div className="checks">
          {TOOL_NAMES.map((t) => (
            <label key={t} className="check">
              <input
                type="checkbox"
                checked={form.tools[t]}
                onChange={(e) => set("tools", { ...form.tools, [t]: e.target.checked })}
              />
              {t}
            </label>
          ))}
        </div>
        <p className="muted small">web_fetch / web_search 在 limited 網路下只能連到 environment 的 allowed_hosts。</p>
      </fieldset>

      <label className="field">
        <span>工具權限</span>
        <select value={form.policy} onChange={(e) => set("policy", e.target.value as PermissionPolicy)}>
          <option value="auto">auto：伺服器評估，安全的直接執行、無法判斷時問你</option>
          <option value="always_ask">always_ask：每次執行前都問你</option>
          <option value="always_allow">always_allow：全部直接執行</option>
        </select>
      </label>

      <div className="row">
        <button className="btn primary" disabled={busy || !form.name.trim()} onClick={save}>
          {busy ? "儲存中…" : existing ? "儲存為新版本" : "建立 agent"}
        </button>
      </div>
      {msg && <div className={msg.ok ? "field-ok" : "field-error"}>{msg.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Environment

interface EnvForm {
  name: string;
  networking: "unrestricted" | "limited";
  allowPackageManagers: boolean;
  allowMcpServers: boolean;
  allowedHosts: string;
}

const NEW_ENV_FORM: EnvForm = {
  name: "pi-claude-env",
  networking: "limited",
  allowPackageManagers: true,
  allowMcpServers: true,
  allowedHosts: "",
};

function formFromEnv(env: Environment): EnvForm {
  const config = env.config;
  if (config.type !== "cloud") return { ...NEW_ENV_FORM, name: env.name };
  const net = config.networking;
  return {
    name: env.name,
    networking: net.type,
    allowPackageManagers: net.type === "limited" ? net.allow_package_managers : true,
    allowMcpServers: net.type === "limited" ? net.allow_mcp_servers : true,
    allowedHosts: net.type === "limited" ? net.allowed_hosts.join(", ") : "",
  };
}

function EnvironmentTab({ settings }: { settings: Settings }) {
  const [envs, setEnvs] = useState<Environment[]>();
  const [selected, setSelected] = useState<string>(settings.environmentId || "new");
  const [form, setForm] = useState<EnvForm>(NEW_ENV_FORM);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const load = useCallback(async () => {
    try {
      const list: Environment[] = [];
      for await (const e of getClient(settings).beta.environments.list({ limit: 100 })) list.push(e);
      setEnvs(list);
      return list;
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKey, settings.baseUrl]);

  useEffect(() => {
    if (!settings.apiKey) return;
    void load().then((list) => {
      const current = list.find((e) => e.id === settings.environmentId);
      if (current) setForm(formFromEnv(current));
      else setSelected("new");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  if (!settings.apiKey) return <p className="muted">請先在「API Key」分頁設定 API key。</p>;

  const existing = envs?.find((e) => e.id === selected);
  const selfHosted = existing?.config.type === "self_hosted";

  const choose = (id: string) => {
    setSelected(id);
    setMsg(undefined);
    const e = envs?.find((x) => x.id === id);
    if (e) {
      setForm(formFromEnv(e));
      updateSettings({ environmentId: e.id });
    } else {
      setForm(NEW_ENV_FORM);
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg(undefined);
    const hosts = form.allowedHosts
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter(Boolean);
    const config: Anthropic.Beta.Environments.BetaCloudConfigParams = {
      type: "cloud",
      networking:
        form.networking === "unrestricted"
          ? { type: "unrestricted" }
          : {
              type: "limited",
              allow_package_managers: form.allowPackageManagers,
              allow_mcp_servers: form.allowMcpServers,
              allowed_hosts: hosts,
            },
    };
    try {
      const client = getClient(settings);
      const saved = existing
        ? await client.beta.environments.update(existing.id, { name: form.name, config })
        : await client.beta.environments.create({ name: form.name, config });
      updateSettings({ environmentId: saved.id });
      setSelected(saved.id);
      await load();
      setMsg({ ok: true, text: `已儲存 ${saved.id}。設定只套用到之後新建的容器。` });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof EnvForm>(k: K, v: EnvForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="form">
      <p className="muted">Environment 是容器的範本：網路權限、可安裝的套件。每個 session 會用它開一個獨立容器。</p>
      <label className="field">
        <span>使用的 Environment</span>
        <select value={selected} onChange={(e) => choose(e.target.value)}>
          <option value="new">＋ 建立新的 environment</option>
          {envs?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}（{e.config.type === "cloud" ? e.config.networking.type : e.config.type}）
            </option>
          ))}
        </select>
      </label>
      {selfHosted ? (
        <p className="muted">這是 self-hosted environment，網路設定由你自己的 worker 主機決定，這裡無法編輯。</p>
      ) : (
        <>
          <label className="field">
            <span>名稱</span>
            <input value={form.name} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label className="field">
            <span>網路</span>
            <select
              value={form.networking}
              onChange={(e) => set("networking", e.target.value as EnvForm["networking"])}
            >
              <option value="limited">limited：預設封鎖，只開放下面勾選的</option>
              <option value="unrestricted">unrestricted：容器可以連任何網站</option>
            </select>
          </label>
          {form.networking === "limited" ? (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.allowPackageManagers}
                  onChange={(e) => set("allowPackageManagers", e.target.checked)}
                />
                允許套件管理器（npm、PyPI 等）
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.allowMcpServers}
                  onChange={(e) => set("allowMcpServers", e.target.checked)}
                />
                允許 agent 設定的 MCP server
              </label>
              <label className="field">
                <span>其他允許的主機（逗號分隔，可用 *.example.com）</span>
                <input
                  value={form.allowedHosts}
                  placeholder="api.example.com, *.githubusercontent.com"
                  onChange={(e) => set("allowedHosts", e.target.value)}
                />
              </label>
            </>
          ) : (
            <p className="field-warn">
              unrestricted 讓容器裡的所有程式（包括 agent 寫的）都能連外。請勿在容器裡放敏感檔案或密鑰。
            </p>
          )}
          <div className="row">
            <button className="btn primary" disabled={busy || !form.name.trim()} onClick={save}>
              {busy ? "儲存中…" : existing ? "更新 environment" : "建立 environment"}
            </button>
          </div>
        </>
      )}
      {msg && <div className={msg.ok ? "field-ok" : "field-error"}>{msg.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Session defaults

function SessionDefaultsTab({ settings }: { settings: Settings }) {
  return (
    <div className="form">
      <p className="muted">新對話時預設掛載的 GitHub repo，會 clone 到容器的 /workspace/&lt;repo 名稱&gt;。新對話畫面上還可以再改。</p>
      <label className="field">
        <span>GitHub repo URL</span>
        <input
          value={settings.repoUrl}
          placeholder="https://github.com/owner/repo"
          onChange={(e) => updateSettings({ repoUrl: e.target.value })}
        />
      </label>
      <label className="field">
        <span>分支（留空用預設分支）</span>
        <input value={settings.repoBranch} onChange={(e) => updateSettings({ repoBranch: e.target.value })} />
      </label>
      <label className="field">
        <span>GitHub token（fine-grained PAT；Contents: Read and write 才能 push）</span>
        <input
          type="password"
          autoComplete="off"
          value={settings.githubToken}
          placeholder="github_pat_..."
          onChange={(e) => updateSettings({ githubToken: e.target.value })}
        />
      </label>
      <p className="muted small">
        Token 由 Anthropic 的 git proxy 在容器外注入，容器內的程式讀不到它。
      </p>
      <label className="field">
        <span>每個 session 的花費上限（美元，留空不設）</span>
        <input
          inputMode="decimal"
          value={settings.budgetUsd}
          placeholder="例如 5"
          onChange={(e) => updateSettings({ budgetUsd: e.target.value })}
        />
      </label>
      <p className="muted small">達到上限時 session 會暫停（不會終止），以公開牌價計算。</p>
    </div>
  );
}
