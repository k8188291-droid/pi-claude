import { useRef, useState } from "react";

interface Props {
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  running?: boolean;
  onSend: (text: string) => void | Promise<void>;
  onInterrupt?: () => void;
  children?: React.ReactNode;
}

export function Composer({ placeholder, disabled, disabledReason, running, onSend, onInterrupt, children }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText("");
    void onSend(t);
    ref.current?.focus();
  };

  return (
    <div className="composer">
      {children}
      <div className="composer-box">
        <textarea
          ref={ref}
          value={text}
          rows={Math.min(10, Math.max(2, text.split("\n").length))}
          placeholder={disabled ? disabledReason : (placeholder ?? "輸入訊息，Enter 送出，Shift+Enter 換行")}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-actions">
          {running && onInterrupt && (
            <button className="btn" onClick={onInterrupt} title="中斷 agent 目前的工作">
              ■ 停止
            </button>
          )}
          <button className="btn primary" disabled={disabled || !text.trim()} onClick={submit}>
            送出
          </button>
        </div>
      </div>
    </div>
  );
}
