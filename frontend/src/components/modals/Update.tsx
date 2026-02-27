import { useState, useEffect } from "react";
import {
  IconDownload,
  IconMistOff,
  IconRefreshAlert,
} from "@tabler/icons-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { cn } from "../../lib/utils";
import { useAppContext } from "../../store";
import { capitalize } from "../../lib/api";
import type { Release } from "../../types";
import { Spinner } from "../ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { IconPackageOff, IconRefresh } from "@tabler/icons-react";

const mdClass = `
  text-xs text-muted-foreground leading-relaxed
  [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mb-2 [&_h1]:mt-3 [&_h1:first-child]:mt-0
  [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2:first-child]:mt-0
  [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mb-1 [&_h3]:mt-2 [&_h3:first-child]:mt-0
  [&_p]:mb-2 [&_p:last-child]:mb-0 [&_p]:break-words
  [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ul:last-child]:mb-0 [&_li]:mb-0.5 [&_li]:break-words
  [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol:last-child]:mb-0
  [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[10px] [&_code]:font-mono [&_code]:break-all
  [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:rounded [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre
  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:break-normal
  [&_a]:text-blue-400 [&_a]:underline [&_a]:underline-offset-2 [&_a]:break-all
  [&_strong]:text-foreground [&_strong]:font-semibold
  [&_hr]:border-ring/20 [&_hr]:my-2
  [&_blockquote]:border-l-2 [&_blockquote]:border-ring/40 [&_blockquote]:pl-3 [&_blockquote]:italic
`.trim();

export function UpdateModal({ onInstalled }: { onInstalled: () => void }) {
  const { state, dispatch, showToast } = useAppContext();
  const { updateModalCore, settings } = state;
  const [releases, setReleases] = useState<Release[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [openVersion, setOpenVersion] = useState("");
  const [source, setSource] = useState<"github" | "jsdelivr" | "">("");
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  const coreLabel =
    updateModalCore === "self" ? "XKeen UI" : capitalize(updateModalCore);
  const close = () =>
    dispatch({ type: "SHOW_MODAL", modal: "showUpdateModal", show: false });

  useEffect(() => {
    if (state.showUpdateModal) fetchReleases();
  }, [state.showUpdateModal, updateModalCore]);

  async function fetchReleases() {
    setLoading(true);
    setSelectedVersion("");
    setOpenVersion("");
    setReleases([]);
    setSource("");
    try {
      const res = await fetch(`/api/update?core=${updateModalCore}`);
      const data = await res.json();
      if (data.success && data.releases?.length) {
        setReleases(data.releases);
        setSelectedVersion(data.releases[0].version);
        setOpenVersion(data.releases[0].version);
        setSource(data.source ?? "");
      }
      if (!data.success || !data.releases?.length) throw new Error();
    } catch {
      showToast("Не удалось получить список релизов", "error");
    }
    setLoading(false);
  }

  async function install() {
    if (!selectedVersion) return;
    setInstalling(true);
    close();
    dispatch({
      type: "SET_SERVICE_STATUS",
      status: "pending",
      pendingText: "Обновление...",
    });
    try {
      const res = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          core: updateModalCore,
          version: selectedVersion,
          backup_core: settings.backupCore,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Установлен ${coreLabel} ${selectedVersion}`);
        if (updateModalCore === "self") {
          setTimeout(() => location.reload(), 100);
          return;
        }
        onInstalled();
      } else {
        showToast(data.error || "Ошибка установки", "error");
      }
    } catch {
      showToast("Ошибка установки", "error");
    } finally {
      setInstalling(false);
      dispatch({ type: "SET_SERVICE_STATUS", status: "stopped" });
    }
  }

  return (
    <Dialog
      open={state.showUpdateModal}
      onOpenChange={(open) => !open && close()}
    >
      <DialogContent className="max-w-[95vw]! md:w-187.5 w-full p-0!">
        <div className="flex flex-col max-h-[90dvh] overflow-hidden p-6 gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
              <IconDownload size={24} className="text-chart-2" />
              Обновление {coreLabel}
            </DialogTitle>

            <DialogDescription className="flex items-center justify-between w-full">
              Выберите версию для установки
              <div className="flex items-center gap-1.5">
                {!loading && source && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "rounded-full px-2 h-5 text-xs font-medium border-none",
                      source === "github"
                        ? "bg-green-500/10 text-green-400"
                        : "bg-orange-500/10 text-orange-400",
                    )}
                  >
                    {source === "github" ? "GitHub" : "jsDelivr"}
                  </Badge>
                )}
                {!loading && releases.length > 0 && (
                  <Badge
                    variant="outline"
                    className="rounded-full w-6 h-6 bg-blue-500/10 text-blue-400 border-blue-500/20"
                  >
                    {releases.length}
                  </Badge>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>

          <ScrollArea
            className="shrink-0"
            style={{
              maxHeight: "min(calc(70px * 7 + 8px), calc(90dvh - 160px))",
            }}
          >
            {loading ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground min-h-88">
                <Spinner className="size-10 text-chart-2" />
                <span className="text-sm tracking-normal">
                  Загрузка релизов...
                </span>
              </div>
            ) : releases.length === 0 ? (
              <Empty className="min-h-88 border-none">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <IconMistOff />
                  </EmptyMedia>
                  <EmptyTitle className="text-[16px] tracking-normal">
                    Нет доступных релизов
                  </EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchReleases}
                    className="gap-1.5 bg-card! hover:bg-input!"
                  >
                    <IconRefresh size={14} />
                    Повторить
                  </Button>
                </EmptyContent>
              </Empty>
            ) : source === "github" ? (
              <Accordion
                type="single"
                collapsible
                value={openVersion}
                onValueChange={setOpenVersion}
                className="py-1 px-0.5 flex flex-col gap-1.5"
              >
                {releases.map((release) => {
                  const checked = selectedVersion === release.version;
                  return (
                    <AccordionItem
                      key={release.version}
                      value={release.version}
                      className={cn(
                        "rounded-lg border transition-all",
                        checked
                          ? "border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15"
                          : "border-ring/40 hover:border-[#60a5fa] bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:bg-linear-to-b hover:from-blue-500/15 hover:to-blue-500/5",
                      )}
                    >
                      <AccordionTrigger
                        className="px-3 py-0 hover:no-underline [&>[data-slot=accordion-trigger-icon]]:hidden"
                        onClick={() => setSelectedVersion(release.version)}
                      >
                        <div className="flex items-center justify-between gap-3 w-full py-2.5">
                          <div className="flex flex-col gap-2 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">
                                {release.name || release.version}
                              </span>
                              {release.is_prerelease && (
                                <Badge
                                  variant="outline"
                                  className="text-xs border-none rounded-sm px-2 text-amber-400 bg-amber-500/10"
                                >
                                  Pre-Release
                                </Badge>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {release.published_at}
                            </span>
                          </div>
                          <div
                            className={cn(
                              "size-4 rounded-full border-2 shrink-0 transition-colors flex items-center justify-center",
                              checked
                                ? "border-primary bg-primary"
                                : "border-muted-foreground/50",
                            )}
                          >
                            {checked && (
                              <div className="size-2 rounded-full bg-primary-foreground" />
                            )}
                          </div>
                        </div>
                      </AccordionTrigger>
                      {release.body && (
                        <AccordionContent className="px-3 pb-3 pt-0">
                          <div className="border-t border-ring/20 pt-2.5">
                            <div className="max-h-48 overflow-y-auto">
                              <div className={mdClass}>
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{ img: () => null }}
                                >
                                  {release.body}
                                </ReactMarkdown>
                              </div>
                            </div>
                          </div>
                        </AccordionContent>
                      )}
                    </AccordionItem>
                  );
                })}
              </Accordion>
            ) : (
              <RadioGroup
                value={selectedVersion}
                onValueChange={setSelectedVersion}
                className="py-1 px-0.5 gap-1.5"
              >
                {releases.map((release) => {
                  const checked = selectedVersion === release.version;
                  return (
                    <label
                      key={release.version}
                      htmlFor={release.version}
                      className={cn(
                        "flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all",
                        checked
                          ? "border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15"
                          : "border-ring/40 hover:border-[#60a5fa] bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:bg-linear-to-b from-blue-500/15 to-blue-500/5",
                      )}
                    >
                      <span className="text-sm font-medium truncate">
                        {release.name || release.version}
                      </span>
                      <RadioGroupItem
                        value={release.version}
                        id={release.version}
                        className="mt-0.5 shrink-0"
                      />
                    </label>
                  );
                })}
              </RadioGroup>
            )}
          </ScrollArea>

          <DialogFooter className="shrink-0">
            <Button
              onClick={install}
              disabled={!selectedVersion || installing}
              className="w-full h-9"
            >
              {installing ? "Установка..." : "Установить"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
