import { useState } from "react";
import { IconSettings, IconX, IconAlertTriangle } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "../../lib/utils";
import { useAppContext } from "../../store";
import { apiCall } from "../../lib/api";

type Tab = "gui" | "updates" | "logs";

const SwitchRow = ({
  id,
  label,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
}) => (
  <div className="flex items-center justify-between py-3">
    <Label htmlFor={id} className="cursor-pointer text-sm">
      {label}
    </Label>
    <Switch id={id} checked={checked} onCheckedChange={onToggle} />
  </div>
);

export function SettingsModal() {
  const { state, dispatch, showToast } = useAppContext();
  const { settings } = state;
  const [activeTab, setActiveTab] = useState<Tab>("gui");
  const [newProxy, setNewProxy] = useState("");

  const close = () =>
    dispatch({ type: "SHOW_MODAL", modal: "showSettingsModal", show: false });

  async function saveSetting(path: string, value: unknown) {
    const [section, key] = path.split(".");
    try {
      const body: Record<string, unknown> = {};
      if (["gui", "updater", "log"].includes(section))
        body[section] = key ? { [key]: value } : value;
      const result = await apiCall<any>("PATCH", "settings", body);
      if (!result.success) {
        showToast("Ошибка: " + result.error, "error");
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function toggle(
    key: keyof typeof settings,
    settingPath: string,
    value: boolean,
  ) {
    const ok = await saveSetting(settingPath, value);
    if (ok) dispatch({ type: "SET_SETTINGS", settings: { [key]: value } });
  }

  async function addProxy() {
    let url = newProxy.trim().replace(/\/+$/, "");
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    if (settings.githubProxies.includes(url)) {
      showToast("Уже добавлен", "error");
      return;
    }
    const next = [...settings.githubProxies, url];
    const ok = await saveSetting("updater.github_proxy", next);
    if (ok) {
      dispatch({ type: "SET_SETTINGS", settings: { githubProxies: next } });
      setNewProxy("");
    }
  }

  async function removeProxy(index: number) {
    const next = settings.githubProxies.filter((_, i) => i !== index);
    const ok = await saveSetting("updater.github_proxy", next);
    if (ok)
      dispatch({ type: "SET_SETTINGS", settings: { githubProxies: next } });
  }

  async function setTimezone(value: string) {
    const offset = parseInt(value);
    const ok = await saveSetting("log.timezone", offset);
    if (ok) dispatch({ type: "SET_SETTINGS", settings: { timezone: offset } });
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: "gui", label: "GUI" },
    { id: "updates", label: "Обновления" },
    { id: "logs", label: "Журнал" },
  ];

  return (
    <Dialog
      open={state.showSettingsModal}
      onOpenChange={(open) => !open && close()}
    >
      <DialogContent
        className="max-w-lg! flex flex-col overflow-hidden"
        style={{ maxHeight: "80vh" }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <IconSettings size={24} className="text-chart-2" /> Настройки
          </DialogTitle>
        </DialogHeader>

        <div className="flex border-b border-border gap-1 shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "px-3 py-2 text-sm border-b-2 -mb-px transition-colors cursor-pointer",
                activeTab === tab.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <ScrollArea
          className="flex-1"
          style={{ maxHeight: "calc(80vh - 140px)" }}
        >
          <div className="px-1" style={{ minHeight: 340 }}>
            {activeTab === "gui" && (
              <div>
                <div className="mb-3 p-3 rounded-lg bg-yellow-700/15 border border-amber-500/40 text-xs tracking-wide text-amber-400 flex items-start gap-2">
                  <IconAlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span>
                    Функция экспериментальная. Сделайте бэкап конфигураций перед
                    включением. Несовместимо с комментариями в конфиге.
                  </span>
                </div>
                <SwitchRow
                  id="gui-routing"
                  label="Routing"
                  checked={settings.guiRouting}
                  onToggle={(v) => toggle("guiRouting", "gui.routing", v)}
                />
                <Separator />
                <SwitchRow
                  id="gui-log"
                  label="Log"
                  checked={settings.guiLog}
                  onToggle={(v) => toggle("guiLog", "gui.log", v)}
                />
                <Separator />
                <SwitchRow
                  id="auto-apply"
                  label="Автоприменение"
                  checked={settings.autoApply}
                  onToggle={(v) => toggle("autoApply", "gui.auto_apply", v)}
                />
              </div>
            )}

            {activeTab === "updates" && (
              <div>
                <SwitchRow
                  id="auto-ui"
                  label="Автопроверка (панель)"
                  checked={settings.autoCheckUI}
                  onToggle={(v) =>
                    toggle("autoCheckUI", "updater.auto_check_ui", v)
                  }
                />
                <Separator />
                <SwitchRow
                  id="auto-core"
                  label="Автопроверка (ядро)"
                  checked={settings.autoCheckCore}
                  onToggle={(v) =>
                    toggle("autoCheckCore", "updater.auto_check_core", v)
                  }
                />
                <Separator />
                <SwitchRow
                  id="backup"
                  label="Бэкап ядра"
                  checked={settings.backupCore}
                  onToggle={(v) =>
                    toggle("backupCore", "updater.backup_core", v)
                  }
                />
                <Separator />
                <div className="py-3 space-y-3">
                  <p className="text-sm font-medium">GitHub Proxy</p>
                  {settings.githubProxies.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Прокси не добавлены
                    </p>
                  ) : (
                    settings.githubProxies.map((proxy, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2.5 rounded-lg bg-input-background border border-border"
                      >
                        <span className="text-xs truncate">{proxy}</span>
                        <button
                          onClick={() => removeProxy(i)}
                          className="ml-2 text-muted-foreground hover:text-destructive shrink-0 transition-colors"
                        >
                          <IconX size={16} />
                        </button>
                      </div>
                    ))
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={newProxy}
                      onChange={(e) => setNewProxy(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addProxy()}
                      placeholder="Введите URL прокси..."
                      className="h-9 text-sm"
                    />
                    <Button onClick={addProxy} className="h-9 shrink-0">
                      Добавить
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "logs" && (
              <div className="py-3 flex items-center justify-between">
                <Label className="text-sm">Часовой пояс</Label>
                <Select
                  value={String(settings.timezone)}
                  onValueChange={setTimezone}
                >
                  <SelectTrigger className="w-28 h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 27 }, (_, i) => i - 12).map(
                      (offset) => (
                        <SelectItem
                          key={offset}
                          value={String(offset)}
                          className="p-2 text-sm"
                        >
                          UTC{offset >= 0 ? "+" : ""}
                          {offset}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
