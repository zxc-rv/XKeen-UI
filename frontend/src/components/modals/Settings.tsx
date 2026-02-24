import { useState } from "react";
import { IconSettings, IconX, IconAlertCircle } from "@tabler/icons-react";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAppContext } from "../../store";
import { apiCall } from "../../lib/api";

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
    } catch (e: any) {
      showToast(e.message, "error");
      console.error("Save setting failed:", e);
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

        <Tabs
          defaultValue="gui"
          className="flex flex-col flex-1 overflow-hidden"
        >
          <TabsList
            variant="line"
            className="shrink-0 justify-start rounded-none border-b border-border px-0"
          >
            <TabsTrigger value="gui">GUI</TabsTrigger>
            <TabsTrigger value="updates">Обновления</TabsTrigger>
            <TabsTrigger value="logs">Журнал</TabsTrigger>
          </TabsList>

          <ScrollArea
            className="flex-1"
            style={{ maxHeight: "calc(80vh - 140px)" }}
          >
            <div className="px-1" style={{ minHeight: 340 }}>
              <TabsContent value="gui">
                <div className="mb-3 p-3 rounded-lg bg-[#2a1f0d] border border-amber-500/20 text-xs tracking-wide text-amber-400 flex items-start gap-2">
                  <IconAlertCircle size={19} className="shrink-0 mt-0.5" />
                  <span>
                    Функция экспериментальная. Перед включением сделайте бэкап
                    конфигураций. Несовместимо с комментариями.
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
              </TabsContent>

              <TabsContent value="updates">
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
              </TabsContent>

              <TabsContent value="logs">
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
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
