import { useState, useEffect } from "react";
import { IconFileText } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "../../lib/utils";
import { useAppContext } from "../../store";
import { capitalize } from "../../lib/api";
import { Spinner } from "../ui/spinner";

const TEMPLATES_URL =
  "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/templates.json";
let templatesCache: Record<string, { name: string; url: string }[]> | null =
  null;

export function TemplateModal({
  onImport,
}: {
  onImport: (url: string) => Promise<void>;
}) {
  const { state, dispatch, showToast } = useAppContext();
  const { currentCore } = state;
  const [templates, setTemplates] = useState<{ name: string; url: string }[]>(
    [],
  );
  const [selectedUrl, setSelectedUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const close = () =>
    dispatch({ type: "SHOW_MODAL", modal: "showTemplateModal", show: false });

  useEffect(() => {
    if (state.showTemplateModal) loadTemplates();
  }, [state.showTemplateModal, currentCore]);

  async function loadTemplates() {
    if (!templatesCache) {
      setLoading(true);
      try {
        const res = await fetch(TEMPLATES_URL);
        if (!res.ok) throw new Error(res.statusText);
        templatesCache = await res.json();
      } catch {
        showToast("Не удалось загрузить шаблоны", "error");
        setLoading(false);
        return;
      }
      setLoading(false);
    }
    const list = templatesCache?.[currentCore] ?? [];
    setTemplates(list);
    if (list.length > 0) setSelectedUrl(list[0].url);
  }

  async function handleImport() {
    if (!selectedUrl) return;
    setImporting(true);
    try {
      await onImport(selectedUrl);
      close();
    } catch (e: any) {
      showToast(`Ошибка импорта: ${e.message}`, "error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog
      open={state.showTemplateModal}
      onOpenChange={(open) => !open && close()}
    >
      <DialogContent className="max-w-140! max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
            <IconFileText size={24} className="text-chart-2" />
            Импорт шаблона
            <span className="text-sm font-normal text-muted-foreground"></span>
          </DialogTitle>
          <DialogDescription className="flex items-center justify-between w-full">
            <span>
              Выберите готовый шаблон конфигурации для{" "}
              <span className="text-chart-2 font-semibold">
                {capitalize(currentCore)}
              </span>
            </span>
            {!loading && (
              <Badge className="rounded-full w-6 h-6 bg-blue-500/10 text-blue-400 border-blue-500/20">
                {templates.length}
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
              <Spinner className="size-10 text-chart-2" />
              <span className="text-xs">Загрузка шаблонов...</span>
            </div>
          ) : templates.length === 0 ? (
            <p className="text-center py-12 text-muted-foreground text-sm">
              Нет доступных шаблонов
            </p>
          ) : (
            <RadioGroup
              value={selectedUrl}
              onValueChange={setSelectedUrl}
              className="py-1 gap-1.5"
            >
              {templates.map((template, i) => (
                <div
                  key={i}
                  onClick={() => setSelectedUrl(template.url)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-3.5 rounded-lg border cursor-pointer transition-all",
                    selectedUrl === template.url
                      ? "border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15"
                      : "border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:border-[#60a5fa] hover:bg-linear-to-b from-blue-500/15 to-blue-500/5",
                  )}
                >
                  <RadioGroupItem
                    value={template.url}
                    id={`tpl-${i}`}
                    className="shrink-0"
                  />
                  <span className="text-sm font-medium">{template.name}</span>
                </div>
              ))}
            </RadioGroup>
          )}
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button
            onClick={handleImport}
            disabled={!selectedUrl || importing}
            className="h-9 w-full"
          >
            {importing ? "Загрузка..." : "Импортировать"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
