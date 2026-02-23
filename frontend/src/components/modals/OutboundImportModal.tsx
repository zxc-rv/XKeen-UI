import { useState } from "react";
import {
  IconLink,
  IconCopy,
  IconCheck,
  IconArrowUp,
  IconArrowDown,
  IconX,
} from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "../../store";

function highlightCode(code: string, type: string): string {
  if (type === "outbound" || type === "proxy") {
    const isJson = code.trimStart().startsWith("{");
    if (isJson) {
      return code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(
          /"([^"]+)"(\s*:)/g,
          '<span style="color:#7aa2f7">"$1"</span>$2',
        )
        .replace(/:\s*"([^"]*)"/g, ': <span style="color:#9ece6a">"$1"</span>')
        .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#ff9e64">$1</span>')
        .replace(
          /:\s*(true|false|null)/g,
          ': <span style="color:#bb9af7">$1</span>',
        );
    }
    // YAML
    return code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(
        /^(\s*)([a-zA-Z][\w-]*)(\s*:)/gm,
        '$1<span style="color:#7aa2f7">$2</span>$3',
      )
      .replace(/:\s*(.+)$/gm, (m, val) => {
        const trimmed = val.trim();
        if (/^-?\d+\.?\d*$/.test(trimmed))
          return ': <span style="color:#ff9e64">' + val + "</span>";
        if (/^(true|false|null)$/.test(trimmed))
          return ': <span style="color:#bb9af7">' + val + "</span>";
        if (trimmed.startsWith("'") || trimmed.startsWith('"'))
          return ': <span style="color:#9ece6a">' + val + "</span>";
        return m;
      });
  }
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const SUPPORTED_PROTOCOLS = [
  "ss://",
  "vless://",
  "vmess://",
  "hysteria2://",
  "http://",
  "https://",
  "trojan://",
];

interface Props {
  onGenerate: (uri: string) => { content: string; type: string } | null;
  onAddToConfig: (
    content: string,
    type: string,
    position: "start" | "end",
  ) => void;
}

export function ImportModal({ onGenerate, onAddToConfig }: Props) {
  const { state, dispatch, showToast } = useAppContext();
  const [uri, setUri] = useState("");
  const [result, setResult] = useState<{
    content: string;
    type: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const isValidUri = SUPPORTED_PROTOCOLS.some((p) =>
    uri.toLowerCase().startsWith(p),
  );

  function close() {
    dispatch({ type: "SHOW_MODAL", modal: "showImportModal", show: false });
    setTimeout(() => {
      setUri("");
      setResult(null);
    }, 300);
  }

  function generate() {
    if (!uri.trim()) return;
    try {
      setResult(onGenerate(uri.trim()));
    } catch (e: any) {
      showToast(e.message, "error");
    }
  }

  function copy(e: React.MouseEvent<HTMLButtonElement>) {
    if (!result) return;

    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(result.content);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = result.content;
        textarea.style.cssText =
          "position:absolute;opacity:0;pointer-events:none;z-index:-1;";

        const target = e.currentTarget || document.body;
        target.appendChild(textarea);

        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, 99999);

        document.execCommand("copy");
        target.removeChild(textarea);
      }

      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      showToast("Ошибка копирования", "error");
    }
  }

  function addToConfig(position: "start" | "end") {
    if (!result) return;
    onAddToConfig(result.content, result.type, position);
    close();
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Dialog
        open={state.showImportModal}
        onOpenChange={(open) => !open && close()}
      >
        <DialogContent className="flex flex-col max-h-[90dvh] w-auto! min-w-[min(90vw,480px)]! max-w-[min(90vw,900px)]! overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pb-3">
              <IconLink size={24} className="text-chart-2" /> Добавить прокси
            </DialogTitle>
            <DialogDescription>
              Вставьте ссылку в формате protocol://
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 tracking-wide flex flex-col min-h-0 overflow-y-auto">
            {result && (
              <div className="relative group">
                <pre
                  className="p-3 pr-12 text-[13px] overflow-auto font-[JetBrains_Mono] tracking-tight rounded-lg border border-border"
                  style={{ background: "var(--color-input-background)" }}
                  dangerouslySetInnerHTML={{
                    __html: highlightCode(result.content, result.type),
                  }}
                />

                <div className="absolute top-2 right-2 flex flex-col gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={copy}
                      >
                        {copied ? (
                          <IconCheck size={14} className="text-green-500" />
                        ) : (
                          <IconCopy size={14} />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">Скопировать</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => addToConfig("start")}
                      >
                        <IconArrowUp size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Добавить в начало конфига
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => addToConfig("end")}
                      >
                        <IconArrowDown size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Добавить в конец конфига
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            )}

            <div className="relative">
              <Input
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && isValidUri && generate()}
                placeholder="vless://..."
                className={uri ? "pr-7" : ""}
              />
              {uri && (
                <button
                  onClick={() => setUri("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <IconX size={14} />
                </button>
              )}
            </div>

            <Button
              onClick={generate}
              disabled={!isValidUri}
              className="w-full"
            >
              Сгенерировать
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
