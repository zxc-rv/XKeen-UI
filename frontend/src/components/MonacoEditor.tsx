import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

import * as prettier from "prettier";
import prettierBabel from "prettier/plugins/babel";
import prettierEstree from "prettier/plugins/estree";
import prettierYaml from "prettier/plugins/yaml";
import * as jsyaml from "js-yaml";
import { getFileLanguage } from "../lib/api";

window.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "json") return new jsonWorker();
    return new editorWorker();
  },
};

export interface MonacoEditorRef {
  getValue: () => string;
  setValue: (value: string, newSavedContent?: string) => void;
  setSavedContent: (content: string) => void;
  setLanguage: (language: string) => void;
  validate: (filename: string) => void;
  format: () => void;
  layout: () => void;
  isValid: (filename: string) => boolean;
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null;
  saveViewState: () => any;
  restoreViewState: (state: any) => void;
}

interface Props {
  onContentChange: (content: string, isDirty: boolean) => void;
  onValidationChange: (isValid: boolean, error?: string) => void;
  onReady?: () => void;
}

const THEME: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "string.key.json", foreground: "7aa2f7" },
    { token: "string.value.json", foreground: "9ece6a" },
    { token: "number.json", foreground: "ff9e64" },
    { token: "number.yaml", foreground: "ff9e64" },
    { token: "keyword.json", foreground: "bb9af7" },
    { token: "keyword.yaml", foreground: "bb9af7" },
    { token: "comment", foreground: "565f89" },
    { token: "string.yaml", foreground: "9ece6a" },
    { token: "type.yaml", foreground: "7aa2f7" },
  ],
  colors: {
    "editor.background": "#080e1d",
    "editor.foreground": "#c0caf5",
    "editorLineNumber.foreground": "#3b4261",
    "editorLineNumber.activeForeground": "#a9b1d6",
    "editorCursor.foreground": "#c0caf5",
    "editor.selectionBackground": "#364a82",
    "editor.inactiveSelectionBackground": "#292e42",
    "editorBracketMatch.border": "#7aa2f7",
    "editorBracketMatch.background": "#283457",
    "editorGutter.modifiedBackground": "#7aa2f7",
    "editorGutter.addedBackground": "#9ece6a",
    "editorGutter.deletedBackground": "#f7768e",
  },
};

export const MonacoEditor = forwardRef<MonacoEditorRef, Props>(
  ({ onContentChange, onValidationChange, onReady }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

    const onContentChangeRef = useRef(onContentChange);
    const onValidationChangeRef = useRef(onValidationChange);
    const onReadyRef = useRef(onReady);
    const savedContentRef = useRef("");
    const filenameRef = useRef("");
    const suppressRef = useRef(false);

    onContentChangeRef.current = onContentChange;
    onValidationChangeRef.current = onValidationChange;
    onReadyRef.current = onReady;

    useImperativeHandle(ref, () => ({
      getValue: () => editorRef.current?.getValue() ?? "",
      setValue: (value: string, newSavedContent?: string) => {
        if (!editorRef.current) return;
        suppressRef.current = true;
        if (newSavedContent !== undefined)
          savedContentRef.current = newSavedContent;
        editorRef.current.setValue(value);
        suppressRef.current = false;
      },
      setSavedContent: (content: string) => {
        savedContentRef.current = content;
      },
      setLanguage: (language: string) => {
        if (editorRef.current)
          monaco.editor.setModelLanguage(
            editorRef.current.getModel()!,
            language,
          );
        filenameRef.current = language;
      },
      validate: (filename: string) => {
        filenameRef.current = filename;
        if (!editorRef.current) return;
        runValidation(editorRef.current, filename);
      },
      format: () =>
        editorRef.current?.getAction("editor.action.formatDocument")?.run(),
      layout: () => editorRef.current?.layout(),
      isValid: (fname: string) => {
        if (!editorRef.current) return false;
        const lang = getFileLanguage(fname);
        if (lang === "json") {
          const model = editorRef.current.getModel();
          if (!model) return true;
          const markers = monaco.editor.getModelMarkers({ owner: "json" });
          return !markers.some(
            (m) =>
              m.resource.toString() === model.uri.toString() &&
              m.severity === monaco.MarkerSeverity.Error,
          );
        }
        if (lang === "yaml") {
          try {
            jsyaml.load(editorRef.current.getValue());
            return true;
          } catch {
            return false;
          }
        }
        return true;
      },
      saveViewState: () => editorRef.current?.saveViewState() ?? null,
      restoreViewState: (state: any) => {
        if (state && editorRef.current)
          editorRef.current.restoreViewState(state);
      },
      getEditor: () => editorRef.current,
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      monaco.editor.defineTheme("tokyo-night", THEME);
      jsonDefaults.setDiagnosticsOptions({
        allowComments: true,
      });
      jsonDefaults.setModeConfiguration({
        ...jsonDefaults.modeConfiguration,
        documentFormattingEdits: false,
      });

      const isMobile = window.innerWidth < 768;
      const editor = monaco.editor.create(containerRef.current, {
        value: "",
        language: "json",
        theme: "tokyo-night",
        automaticLayout: true,
        colorDecorators: false,
        scrollBeyondLastLine: false,
        minimap: { enabled: !isMobile, showSlider: "always" },
        fontSize: isMobile ? 13 : 14,
        fontFamily: '"JetBrains Mono", monospace, "Noto Color Emoji"',
        fontWeight: "400",
        smoothScrolling: true,
        lineHeight: 1.5,
        renderLineHighlight: "none",
        tabSize: 2,
        insertSpaces: true,
        wordWrap: "off",
        folding: !isMobile,
        lineNumbers: isMobile ? "off" : "on",
        glyphMargin: false,
        stickyScroll: { enabled: false },
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
        scrollbar: {
          vertical: "hidden",
          horizontal: "hidden",
          verticalScrollbarSize: 0,
          useShadows: false,
        },
        quickSuggestions: !isMobile,
        suggestOnTriggerCharacters: !isMobile,
        accessibilitySupport: isMobile ? "off" : "auto",
      });

      editorRef.current = editor;
      registerFormatters();

      const markerDisposable = monaco.editor.onDidChangeMarkers((uris) => {
        if (getFileLanguage(filenameRef.current) !== "json") return;
        const model = editor.getModel();
        if (!model || !uris.some((u) => u.toString() === model.uri.toString()))
          return;
        const markers = monaco.editor.getModelMarkers({
          owner: "json",
          resource: model.uri,
        });
        const err = markers.find(
          (m) => m.severity === monaco.MarkerSeverity.Error,
        );
        onValidationChangeRef.current(!err, err?.message);
      });

      editor.onDidChangeModelContent(() => {
        if (suppressRef.current) return;
        const content = editor.getValue();
        const isDirty = content !== savedContentRef.current;
        onContentChangeRef.current(content, isDirty);
        if (getFileLanguage(filenameRef.current) === "yaml")
          runValidation(editor, filenameRef.current);
      });

      onReadyRef.current?.();

      return () => {
        markerDisposable.dispose();
        editor.dispose();
      };
    }, []);

    function runValidation(
      editor: monaco.editor.IStandaloneCodeEditor,
      filename: string,
    ) {
      const lang = getFileLanguage(filename);
      if (lang === "yaml") {
        try {
          jsyaml.load(editor.getValue());
          monaco.editor.setModelMarkers(editor.getModel()!, "yaml", []);
          onValidationChangeRef.current(true);
        } catch (e: any) {
          const line = e.mark ? e.mark.line + 1 : 1;
          const col = e.mark ? e.mark.column + 1 : 1;
          const msg = e.mark
            ? `${e.reason || e.message} [строка ${line}]`
            : e.message;
          monaco.editor.setModelMarkers(editor.getModel()!, "yaml", [
            {
              severity: monaco.MarkerSeverity.Error,
              message: msg,
              startLineNumber: line,
              startColumn: col,
              endLineNumber: line,
              endColumn: 999,
            },
          ]);
          onValidationChangeRef.current(false, msg);
        }
      } else if (lang === "json") {
        setTimeout(() => {
          const model = editor.getModel();
          if (!model) return;
          const markers = monaco.editor.getModelMarkers({
            owner: "json",
            resource: model.uri,
          });
          const err = markers.find(
            (m) => m.severity === monaco.MarkerSeverity.Error,
          );
          onValidationChangeRef.current(!err, err?.message);
        }, 300);
      } else {
        onValidationChangeRef.current(true);
      }
    }

    function registerFormatters() {
      monaco.languages.registerDocumentFormattingEditProvider("json", {
        async provideDocumentFormattingEdits(model) {
          try {
            const text = await prettier.format(model.getValue(), {
              parser: "json",
              plugins: [prettierBabel, prettierEstree],
              semi: false,
              trailingComma: "none",
              printWidth: 120,
              endOfLine: "lf",
            });
            return [
              {
                range: model.getFullModelRange(),
                text: text
                  .replace(/\n{3,}/g, "\n\n")
                  .replace(/\s+$/gm, "")
                  .replace(/\n$/, ""),
              },
            ];
          } catch {
            return [];
          }
        },
      });
      monaco.languages.registerDocumentFormattingEditProvider("yaml", {
        async provideDocumentFormattingEdits(model) {
          try {
            const text = await prettier.format(model.getValue(), {
              parser: "yaml",
              plugins: [prettierYaml],
              printWidth: 200,
              tabWidth: 2,
              singleQuote: true,
              endOfLine: "lf",
            });
            return [{ range: model.getFullModelRange(), text }];
          } catch {
            return [];
          }
        },
      });
    }

    return (
      <div className="absolute inset-4 rounded-md overflow-hidden border border-border bg-input-background">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    );
  },
);

MonacoEditor.displayName = "MonacoEditor";
