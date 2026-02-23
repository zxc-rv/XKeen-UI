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
import { Badge } from "@/components/ui/badge";
import { useAppContext } from "../../store";

function highlightYaml(code: string): string {
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split("\n")
    .map((line) => {
      // Comments
      if (/^\s*#/.test(line))
        return `<span style="color:#565f89">${line}</span>`;

      // List item marker
      const listMatch = line.match(/^(\s*-\s)(.*)$/);
      if (listMatch) {
        const [, marker, rest] = listMatch;
        return `<span style="color:#89ddff">${marker}</span>${highlightYamlValue(rest)}`;
      }

      // Key: value
      const kvMatch = line.match(/^(\s*)([a-zA-Z_][\w.-]*)(\s*:)(.*)?$/);
      if (kvMatch) {
        const [, indent, key, colon, rest] = kvMatch;
        const value = rest ?? "";
        return `${indent}<span style="color:#7aa2f7">${key}</span>${colon}${highlightYamlValue(value)}`;
      }

      return line;
    })
    .join("\n");
}

function highlightYamlValue(value: string): string {
  if (!value.trim()) return value;
  const trimmed = value.trim();

  // Inline comment at end
  const commentIdx = value.search(/\s+#/);
  if (commentIdx !== -1) {
    const main = value.slice(0, commentIdx);
    const comment = value.slice(commentIdx);
    return (
      highlightYamlValue(main) + `<span style="color:#565f89">${comment}</span>`
    );
  }

  if (/^-?\d+\.?\d*$/.test(trimmed))
    return value.replace(
      trimmed,
      `<span style="color:#ff9e64">${trimmed}</span>`,
    );
  if (/^(true|false|null|~)$/.test(trimmed))
    return value.replace(
      trimmed,
      `<span style="color:#bb9af7">${trimmed}</span>`,
    );
  if (/^["']/.test(trimmed))
    return value.replace(
      trimmed,
      `<span style="color:#9ece6a">${trimmed}</span>`,
    );
  if (
    trimmed &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[") &&
    !trimmed.startsWith("*") &&
    !trimmed.startsWith("&")
  )
    return value.replace(
      trimmed,
      `<span style="color:#9ece6a">${trimmed}</span>`,
    );

  return value;
}

function highlightJson(code: string): string {
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"([^"]+)"(\s*:)/g, '<span style="color:#7aa2f7">"$1"</span>$2')
    .replace(/:\s*"([^"]*)"/g, ': <span style="color:#9ece6a">"$1"</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#ff9e64">$1</span>')
    .replace(
      /:\s*(true|false|null)/g,
      ': <span style="color:#bb9af7">$1</span>',
    );
}

function highlightCode(code: string): string {
  return code.trimStart().startsWith("{")
    ? highlightJson(code)
    : highlightYaml(code);
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
    protocol: string;
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
      const generated = onGenerate(uri.trim());
      if (generated) {
        const protocol =
          uri.match(/^([a-zA-Z0-9+\-.]+):\/\//)?.[1]?.toUpperCase() ?? "";
        setResult({ ...generated, protocol });
      } else {
        setResult(null);
      }
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
    } catch {
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

          <div className="space-y-3 flex flex-col min-h-0 overflow-y-auto">
            {/* Result block */}
            {result && (
              <div className="rounded-lg border border-border overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
                  <Badge
                    variant="outline"
                    className="font-mono text-xs tracking-wide px-2 py-0.5"
                  >
                    {result.protocol}
                  </Badge>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
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
                </div>

                {/* Snippet */}
                <pre
                  className="p-3 text-[13px] overflow-auto font-[JetBrains_Mono] tracking-tight"
                  style={{ background: "var(--color-input-background)" }}
                  dangerouslySetInnerHTML={{
                    __html: highlightCode(result.content),
                  }}
                />

                {/* Footer */}
                <div className="flex gap-2 p-2 border-t border-border bg-muted/10">
                  <Button
                    variant="outline"
                    className="flex-1 h-8 text-xs gap-1.5"
                    onClick={() => addToConfig("start")}
                  >
                    <IconArrowUp size={13} /> Добавить в начало
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 h-8 text-xs gap-1.5"
                    onClick={() => addToConfig("end")}
                  >
                    <IconArrowDown size={13} /> Добавить в конец
                  </Button>
                </div>
              </div>
            )}

            {/* Input */}
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
