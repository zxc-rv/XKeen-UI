import { useState, useEffect, useCallback } from "react";
import * as prettier from "prettier";
import prettierBabel from "prettier/plugins/babel";
import { Switch } from "@/components/ui/switch";
import { cn, stripJsonComments } from "../lib/utils";
import { useAppContext } from "../store";
import { apiCall } from "../lib/api";
import type { MonacoEditorRef } from "./MonacoEditor";
import type { Config } from "../types";

const LOG_LEVELS = ["none", "error", "warning", "info", "debug"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_COLOR: Record<LogLevel, string> = {
  none: "#ffffff",
  error: "#22c55e",
  warning: "#eab308",
  info: "#f97316",
  debug: "#ef4444",
};

const ACCESS_PATH = "/opt/var/log/xray/access.log";
const ERROR_PATH = "/opt/var/log/xray/error.log";

interface LogConfig {
  access: string;
  error: string;
  loglevel: LogLevel;
  dnsLog: boolean;
}

function parseLogConfig(content: string): LogConfig | null {
  try {
    const json = JSON.parse(stripJsonComments(content));
    if (!json?.log) return null;
    return {
      access: json.log.access ?? "",
      error: json.log.error ?? "",
      loglevel: (LOG_LEVELS.includes(json.log.loglevel)
        ? json.log.loglevel
        : "warning") as LogLevel,
      dnsLog: json.log.dnsLog ?? false,
    };
  } catch {
    return null;
  }
}

interface Props {
  editorRef: React.RefObject<MonacoEditorRef | null>;
  configs: Config[];
  activeConfigIndex: number;
}

export function GuiLog({ editorRef, configs, activeConfigIndex }: Props) {
  const { showToast, state, dispatch } = useAppContext();
  const [cfg, setCfg] = useState<LogConfig>(() => {
    const content = configs[activeConfigIndex]?.content ?? "";
    return (
      parseLogConfig(content) ?? {
        access: "",
        error: "",
        loglevel: "warning",
        dnsLog: false,
      }
    );
  });

  useEffect(() => {
    const content =
      configs[activeConfigIndex]?.content ??
      editorRef.current?.getValue() ??
      "";
    const parsed = parseLogConfig(content);
    if (parsed) setCfg(parsed);
  }, [activeConfigIndex]);

  const syncToEditor = useCallback(
    async (newCfg: LogConfig, triggerRestart = false) => {
      const wrapper = editorRef.current;
      if (!wrapper) return;
      const monacoEditor = wrapper.getEditor();
      if (!monacoEditor) return;
      const model = monacoEditor.getModel();
      if (!model) return;
      try {
        const json = JSON.parse(stripJsonComments(wrapper.getValue()));
        json.log = {
          access: newCfg.access || "none",
          error: newCfg.error || "none",
          loglevel: newCfg.loglevel,
          dnsLog: newCfg.dnsLog,
        };
        let text = JSON.stringify(json, null, 2);
        try {
          const formatted = await prettier.format(text, {
            parser: "json",
            plugins: [prettierBabel],
            semi: false,
            trailingComma: "none",
            printWidth: 120,
            endOfLine: "lf",
          });
          text = formatted
            .replace(/\n{3,}/g, "\n\n")
            .replace(/\s+$/gm, "")
            .replace(/\n$/, "");
        } catch {}
        monacoEditor.executeEdits("gui-log", [
          { range: model.getFullModelRange(), text },
        ]);

        if (
          triggerRestart &&
          state.settings.autoApply &&
          state.serviceStatus === "running"
        ) {
          const activeConfig = configs[activeConfigIndex];
          if (activeConfig) {
            const content = monacoEditor.getValue();
            await apiCall<{ success: boolean; error?: string }>(
              "PUT",
              "configs",
              { action: "save", file: activeConfig.file, content },
            );
            dispatch({
              type: "SAVE_CONFIG",
              index: activeConfigIndex,
              content,
            });
            dispatch({
              type: "SET_SERVICE_STATUS",
              status: "pending",
              pendingText: "Перезапуск...",
            });
            const r = await apiCall<{ success: boolean; error?: string }>(
              "POST",
              "control",
              { action: "softRestart", core: state.currentCore },
            );
            showToast(
              r?.success ? "Изменения применены" : `Ошибка: ${r?.error}`,
              r?.success ? "success" : "error",
            );
            dispatch({ type: "SET_SERVICE_STATUS", status: "running" });
          }
        }
      } catch (e: any) {
        showToast(`Ошибка синхронизации: ${e.message}`, "error");
      }
    },
    [
      editorRef,
      showToast,
      state.settings.autoApply,
      state.serviceStatus,
      state.currentCore,
      configs,
      activeConfigIndex,
      dispatch,
    ],
  );

  function update(partial: Partial<LogConfig>, triggerRestart = false) {
    const next = { ...cfg, ...partial };
    setCfg(next);
    syncToEditor(next, triggerRestart);
  }

  const levelIndex = LOG_LEVELS.indexOf(cfg.loglevel);
  const color = LEVEL_COLOR[cfg.loglevel];

  return (
    <div className="absolute inset-0 overflow-y-auto p-4 sm:p-6 flex flex-col gap-6 sm:gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="font-semibold text-base">Access Log</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <PathButton
            label="none"
            active={!cfg.access || cfg.access === "none"}
            onClick={() => update({ access: "none" }, true)}
          />
          <PathButton
            label={ACCESS_PATH}
            active={cfg.access === ACCESS_PATH}
            onClick={() => update({ access: ACCESS_PATH }, true)}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="font-semibold text-base">Error Log</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <PathButton
            label="none"
            active={!cfg.error || cfg.error === "none"}
            onClick={() => update({ error: "none" }, true)}
          />
          <PathButton
            label={ERROR_PATH}
            active={cfg.error === ERROR_PATH}
            onClick={() => update({ error: ERROR_PATH }, true)}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="font-semibold text-base">Log Level</h3>
        <div className="px-2">
          <div className="relative h-8 flex items-center">
            <div className="absolute inset-x-0 h-1.5 rounded-full bg-muted" />
            <div
              className="absolute left-0 h-1.5 rounded-full transition-all duration-200"
              style={{
                width: `${(levelIndex / (LOG_LEVELS.length - 1)) * 100}%`,
                background: color,
              }}
            />
            {LOG_LEVELS.map((l, i) => {
              const pct = (i / (LOG_LEVELS.length - 1)) * 100;
              const active = i <= levelIndex;
              return (
                <button
                  key={l}
                  onClick={() => update({ loglevel: l }, true)}
                  className="cursor-pointer absolute -translate-x-1/2 w-4 h-4 rounded-full border-2 transition-all duration-200 hover:scale-125 z-10"
                  style={{
                    left: `${pct}%`,
                    background: active ? color : "var(--color-muted)",
                    borderColor: active ? color : "var(--color-border)",
                    boxShadow:
                      i === levelIndex ? `0 0 10px ${color}99` : "none",
                  }}
                />
              );
            })}
          </div>
          <div className="relative h-5 mt-1">
            {LOG_LEVELS.map((l, i) => {
              const pct = (i / (LOG_LEVELS.length - 1)) * 100;
              return (
                <button
                  key={l}
                  onClick={() => update({ loglevel: l }, true)}
                  className={cn(
                    "absolute -translate-x-1/2 text-[10px] uppercase tracking-wide font-medium transition-colors whitespace-nowrap",
                    i <= levelIndex
                      ? "text-foreground"
                      : "text-muted-foreground/40",
                  )}
                  style={{ left: `${pct}%` }}
                >
                  {l}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="font-semibold text-base">DNS Log</h3>
        <div className="flex items-center gap-3">
          <Switch
            checked={cfg.dnsLog}
            onCheckedChange={(v) => update({ dnsLog: v }, true)}
          />
          <span className="text-sm text-muted-foreground">
            {cfg.dnsLog ? "Включено" : "Выключено"}
          </span>
        </div>
      </section>
    </div>
  );
}

function PathButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "cursor-pointer h-11 px-4 rounded-lg border text-sm font-medium transition-all truncate",
        active
          ? "border-chart-2 bg-blue-500/10 text-blue-400"
          : "border-border bg-card text-muted-foreground hover:border-chart-2 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
