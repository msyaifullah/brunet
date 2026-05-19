/**
 * CodeMirror body editor for request payloads (JSON, XML, text).
 */

import { EditorState, Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  codeFolding,
  foldAll,
  foldGutter,
  foldKeymap,
  unfoldAll,
} from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";

export interface BodyEditorOptions {
  /** When true, content cannot be edited (console request/response bodies). */
  readOnly?: boolean;
}

export interface BodyEditorHandle {
  view: EditorView;
  destroy: () => void;
  getValue: () => string;
  setValue: (value: string) => void;
  foldAll: () => void;
  unfoldAll: () => void;
}

/** Infer body syntax from Content-Type when present. */
export function inferBodyTypeFromHeaders(
  headers: Record<string, string>,
  body: string,
  fallback = "",
): BodyTypeOption {
  const ct =
    headers["content-type"] ??
    headers["Content-Type"] ??
    "";
  const lower = ct.toLowerCase();
  if (lower.includes("json")) return "json";
  if (lower.includes("xml")) return "xml";
  return inferBodyType(body, fallback);
}

export const BODY_TYPE_OPTIONS = ["json", "xml", "text"] as const;
export type BodyTypeOption = (typeof BODY_TYPE_OPTIONS)[number];

export function normalizeBodyType(bodyType: string): BodyTypeOption {
  const t = bodyType.toLowerCase();
  if (t === "json" || t === "xml" || t === "text") return t;
  return "text";
}

/** Guess body section type when the .bru file has no body:subtype block yet. */
export function inferBodyType(body: string, current = ""): BodyTypeOption {
  if (current) return normalizeBodyType(current);
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("<")) return "xml";
  return "json";
}

export function canPrettifyBody(bodyType: string): boolean {
  const t = normalizeBodyType(bodyType);
  return t === "json" || t === "xml";
}

export function canFoldBody(bodyType: string): boolean {
  return canPrettifyBody(bodyType);
}

export function prettifyBody(content: string, bodyType: string): string {
  const t = bodyType.toLowerCase();
  const trimmed = content.trim();
  if (!trimmed) return content;

  if (t === "json") {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  }

  if (t === "xml") {
    return prettifyXml(trimmed);
  }

  return content;
}

function prettifyXml(xml: string): string {
  const compact = xml.replace(/>\s+</g, "><").trim();
  const lines = compact.replace(/></g, ">\n<").split("\n");
  let pad = 0;
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.match(/^<\//)) {
      pad = Math.max(0, pad - 1);
    }

    out.push("  ".repeat(pad) + line);

    if (
      line.match(/^<[^!?/]/) &&
      !line.match(/\/>$/) &&
      !line.match(/^<\//) &&
      !line.includes("</")
    ) {
      pad++;
    }
  }

  return out.join("\n");
}

function languageExtension(bodyType: string): Extension[] {
  const t = bodyType.toLowerCase();
  if (t === "json") return [json()];
  if (t === "xml") return [xml()];
  return [];
}

function foldingExtensions(bodyType: string): Extension[] {
  if (!canFoldBody(bodyType)) return [];
  return [
    codeFolding(),
    foldGutter({
      openText: "▾",
      closedText: "▸",
    }),
  ];
}

function buildExtensions(
  bodyType: string,
  isSuppressing: () => boolean,
  options: BodyEditorOptions & { onChange?: (value: string) => void },
): Extension[] {
  const readOnly = options.readOnly === true;
  const extensions: Extension[] = [
    editorTheme,
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    ...foldingExtensions(bodyType),
    ...languageExtension(bodyType),
    EditorView.lineWrapping,
  ];

  if (readOnly) {
    extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    extensions.push(keymap.of([...foldKeymap]));
  } else {
    extensions.push(cmPlaceholder("Request body…"));
    extensions.push(
      keymap.of([...foldKeymap, ...defaultKeymap, indentWithTab]),
    );
    if (options.onChange) {
      const onChange = options.onChange;
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (isSuppressing() || !update.docChanged) return;
          onChange(update.state.doc.toString());
        }),
      );
    }
  }

  return extensions;
}

const editorTheme = EditorView.theme({
  "&": {
    fontSize: "var(--font-ui-small)",
    fontFamily: "var(--font-monospace)",
    backgroundColor: "var(--background-secondary)",
    border: "1px solid var(--background-modifier-border)",
    borderRadius: "var(--radius-s)",
    height: "100%",
  },
  "&.cm-focused": {
    borderColor: "var(--interactive-accent)",
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-monospace)",
  },
  ".cm-content": {
    padding: "0.5em 0",
    caretColor: "var(--text-normal)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--background-secondary)",
    borderRight: "1px solid var(--background-modifier-border)",
    color: "var(--text-faint)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.5em",
    padding: "0 0.35em 0 0.5em",
  },
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 0.15em",
    cursor: "pointer",
    color: "var(--text-muted)",
  },
  ".cm-foldGutter .cm-gutterElement:hover": {
    color: "var(--text-normal)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--background-modifier-border)",
    border: "none",
    color: "var(--text-muted)",
    padding: "0 0.35em",
    borderRadius: "var(--radius-s)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--background-modifier-hover)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--background-modifier-hover)",
    color: "var(--text-normal)",
  },
}, { dark: true });

export function createBodyEditor(
  parent: HTMLElement,
  initialValue: string,
  bodyType: string,
  onChange?: (value: string) => void,
  options: BodyEditorOptions = {},
): BodyEditorHandle {
  const mount = parent.createDiv({ cls: "bru-body-cm-mount" });

  let suppressChange = false;

  const state = EditorState.create({
    doc: initialValue,
    extensions: buildExtensions(bodyType, () => suppressChange, {
      ...options,
      onChange,
    }),
  });

  const view = new EditorView({ state, parent: mount });

  return {
    view,
    destroy: () => view.destroy(),
    getValue: () => view.state.doc.toString(),
    setValue: (value: string) => {
      suppressChange = true;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: value,
        },
      });
      suppressChange = false;
    },
    foldAll: () => {
      foldAll(view);
    },
    unfoldAll: () => {
      unfoldAll(view);
    },
  };
}
