declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}

declare module "monaco-editor/esm/vs/language/json/monaco.contribution" {
  export const jsonDefaults: {
    setDiagnosticsOptions: (options: Record<string, unknown>) => void;
    setModeConfiguration: (config: Record<string, unknown>) => void;
    modeConfiguration: Record<string, unknown>;
  };
}

declare module "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution" {}
declare module "monaco-editor/esm/vs/editor/editor.worker?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
declare module "monaco-editor/esm/vs/language/json/json.worker?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
