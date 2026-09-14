// CodeMirror wrapper themed entirely from VS Code CSS variables.
import { memo, useCallback, useMemo, useRef } from 'react';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Prec } from '@codemirror/state';
import { Decoration, MatchDecorator, ViewPlugin, hoverTooltip, keymap, type DecorationSet, type KeyBinding, type ViewUpdate } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { autocompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { php } from '@codemirror/lang-php';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { http } from '@codemirror/legacy-modes/mode/http';
import { python } from '@codemirror/legacy-modes/mode/python';
import { go } from '@codemirror/legacy-modes/mode/go';
import { java, kotlin, csharp, dart } from '@codemirror/legacy-modes/mode/clike';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import type { CodeSyntax, VariableInfo } from '../../shared/protocol';
import { collapseLongStrings } from '../lib/collapseStrings';
import type { JsonKeySuggestion } from '../lib/suggest';
import { VAR_HOVER_MS, describeVar, isKnownVar, resolvedKeys, suggestVariables, varAt } from '../lib/vars';
import { copyAssist, useCopyAssistToast } from './copyAssist';
import { jsonSuggestionSource } from './jsonCompletion';
import { cx } from './ui';

export type CodeLanguage = 'json' | 'xml' | 'html' | 'text' | CodeSyntax;

const legacy = {
  shell,
  powershell: powerShell,
  http,
  python,
  go,
  java,
  kotlin,
  csharp,
  dart,
  ruby,
  swift,
  rust,
};

const vsTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--vscode-editor-foreground, var(--vscode-foreground))',
    fontSize: 'var(--vscode-editor-font-size, 12px)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
    lineHeight: '1.5',
  },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground, var(--vscode-foreground))' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, var(--vscode-foreground))' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground))',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--vscode-editorLineNumber-activeForeground, var(--vscode-foreground))',
  },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--vscode-editor-selectionHighlightBackground, transparent)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--vscode-editorBracketMatch-background, transparent)',
    outline: '1px solid var(--vscode-editorBracketMatch-border, transparent)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--vscode-editor-foldBackground, transparent)',
    border: 'none',
    color: 'var(--vscode-descriptionForeground)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorWidget-background)',
    border: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))',
  },
  '.cm-panels': { backgroundColor: 'var(--vscode-editorWidget-background)', color: 'var(--vscode-foreground)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33))',
    outline: '1px solid var(--vscode-editor-findMatchHighlightBorder, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--vscode-editor-findMatchBackground, rgba(81, 92, 106, 0.8))',
    outline: '1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder))',
  },
  '.cm-panel.cm-search': {
    padding: '4px 28px 4px 8px',
    fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
    fontSize: '12px',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px 6px',
  },
  '.cm-panel.cm-search br': { display: 'none' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { margin: '0', fontSize: '12px' },
  '.cm-panel.cm-search .cm-textfield': {
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '2px',
    padding: '2px 6px',
    outline: 'none',
    minWidth: '160px',
  },
  '.cm-panel.cm-search .cm-textfield:focus': { borderColor: 'var(--vscode-focusBorder)' },
  '.cm-panel.cm-search .cm-button': {
    background: 'var(--vscode-button-secondaryBackground, var(--vscode-input-background))',
    backgroundImage: 'none',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-button-border, transparent)',
    borderRadius: '2px',
    padding: '1px 8px',
    textTransform: 'capitalize',
  },
  '.cm-panel.cm-search .cm-button:hover': {
    background: 'var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground))',
  },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--vscode-descriptionForeground)' },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--vscode-foreground)',
    fontSize: '16px',
    top: '3px',
    right: '6px',
    cursor: 'pointer',
  },
  '.cm-view-more': {
    marginLeft: '2px',
    padding: '0 4px',
    borderRadius: '3px',
    fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
    fontSize: '11px',
    color: 'var(--vscode-textLink-foreground)',
    background: 'var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.15))',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-view-more:hover': { textDecoration: 'underline' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background))',
    border: '1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-editorWidget-border, var(--vscode-panel-border)))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, monospace)',
    maxHeight: '220px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground))',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground, inherit))',
  },
  '.cm-completionLabel': { color: 'var(--vscode-textLink-foreground)' },
  '.cm-completionDetail': { marginLeft: '12px', fontStyle: 'normal', opacity: '0.7' },
});

type VarsRef = { current: readonly VariableInfo[] | undefined };

/** {{variable}} marks (blue when it resolves, red otherwise). Reads variables through a ref. */
function variableMarks(vars: VarsRef): Extension {
  const known = Decoration.mark({ class: 'cm-var-known' });
  const unknown = Decoration.mark({ class: 'cm-var-unknown' });
  const decorator = new MatchDecorator({
    regexp: /\{\{\s*([^{}]*?)\s*\}\}/g,
    decoration: (m) => (isKnownVar(m[1], resolvedKeys(vars.current ?? [])) ? known : unknown),
  });
  const marks = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (p) => p.decorations },
  );
  return marks;
}

/** Resting the pointer on a {{variable}} shows its value and scope. */
function variableHover(vars: VarsRef): Extension {
  return hoverTooltip(
    (view, pos) => {
      const line = view.state.doc.lineAt(pos);
      const hit = varAt(line.text, pos - line.from);
      if (!hit) return null;
      return {
        pos: line.from + hit.from,
        end: line.from + hit.to,
        above: true,
        create: () => {
          const d = describeVar(hit.name, vars.current ?? []);
          const dom = document.createElement('div');
          dom.className = 'cm-var-hover';
          const head = dom.appendChild(document.createElement('div'));
          head.style.cssText = 'display:flex;gap:8px;align-items:baseline';
          const name = head.appendChild(document.createElement('span'));
          name.className = d.state === 'unresolved' ? 'text-error' : 'text-var-known';
          name.style.cssText = 'font-family:var(--vscode-editor-font-family,monospace);font-weight:600;font-size:12px';
          name.textContent = d.name;
          if (d.source) {
            const src = head.appendChild(document.createElement('span'));
            src.style.cssText = 'font-size:10.5px;opacity:.65';
            src.textContent = d.source;
          }
          const value = dom.appendChild(document.createElement('div'));
          value.style.cssText = `margin-top:2px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;word-break:break-all;${d.state === 'value' ? '' : 'font-style:italic;opacity:.75'}`;
          value.textContent = d.value;
          if (d.suggestion) {
            const hint = dom.appendChild(document.createElement('div'));
            hint.style.cssText = 'margin-top:4px;font-size:11.5px';
            hint.append('Did you mean ');
            const s = hint.appendChild(document.createElement('span'));
            s.className = 'text-var-known';
            s.style.fontFamily = 'var(--vscode-editor-font-family,monospace)';
            s.textContent = d.suggestion;
            hint.append('?');
          }
          return { dom };
        },
      };
    },
    { hoverTime: VAR_HOVER_MS },
  );
}

/** `{{` completion of variable names. */
function variableSource(vars: VarsRef) {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/\{\{\s*[\w.$-]*/);
    if (!m) return null;
    const from = m.from + (/^\{\{\s*/.exec(m.text)?.[0].length ?? 2);
    const options: Completion[] = suggestVariables(vars.current ?? [], '').map((v) => ({
      label: v.key,
      detail: v.secret ? (v.resolved ? '•••••• ' : 'no value ') + v.source : v.source === 'dynamic' ? 'generated' : `${v.value.slice(0, 40)}  ${v.source}`,
      apply: (view, _c, start, end) => {
        const closed = view.state.sliceDoc(end, end + 2) === '}}';
        const insert = closed ? v.key : `${v.key}}}`;
        view.dispatch({ changes: { from: start, to: end, insert }, selection: { anchor: start + insert.length + (closed ? 2 : 0) }, userEvent: 'input.complete' });
      },
    }));
    return { from, options, validFor: /^[\w.$-]*$/ };
  };
}

const vsHighlight = HighlightStyle.define([
  { tag: [t.string, t.special(t.string), t.docString], color: 'var(--vscode-debugTokenExpression-string, #ce9178)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--vscode-debugTokenExpression-number, #b5cea8)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--vscode-debugTokenExpression-boolean, #569cd6)' },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self], color: 'var(--vscode-symbolIcon-keywordForeground, #c586c0)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--vscode-debugTokenExpression-name, #9cdcfe)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--vscode-symbolIcon-functionForeground, #dcdcaa)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--vscode-symbolIcon-variableForeground, #9cdcfe)' },
  { tag: [t.className, t.namespace, t.standard(t.variableName)], color: 'var(--vscode-symbolIcon-classForeground, #4ec9b0)' },
  { tag: [t.heading, t.url], color: 'var(--vscode-textLink-foreground, #3794ff)' },
  { tag: [t.escape, t.regexp, t.special(t.variableName)], color: 'var(--vscode-debugTokenExpression-number, #d7ba7d)' },
  { tag: [t.tagName, t.typeName], color: 'var(--vscode-symbolIcon-classForeground, #4ec9b0)' },
  { tag: [t.comment, t.meta, t.processingInstruction], color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.bracket, t.angleBracket], color: 'var(--vscode-editor-foreground, var(--vscode-foreground))' },
  { tag: t.invalid, color: 'var(--vscode-errorForeground)' },
]);

/**
 * Cmd/Ctrl+F opens the search panel. Handled at highest precedence (not only via searchKeymap) so it still
 * works when the VS Code webview host has already marked the find shortcut as handled.
 */
const searchShortcut = EditorView.domEventHandlers({
  keydown(event, view) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openSearchPanel(view);
      return true;
    }
    return false;
  },
});

const baseExtensions: Extension[] = [vsTheme, syntaxHighlighting(vsHighlight), Prec.highest(searchShortcut)];

function languageExtension(lang: CodeLanguage): Extension[] {
  switch (lang) {
    case 'json':
      return [json()];
    case 'xml':
      return [xml()];
    case 'html':
      return [html()];
    case 'javascript':
      return [javascript()];
    case 'php':
      return [php({ plain: false })];
    case 'text':
      return [];
    default:
      return [StreamLanguage.define(legacy[lang])];
  }
}

export interface CodeViewProps {
  value: string;
  onChange?: (value: string, update?: ViewUpdate) => void;
  language?: CodeLanguage;
  readOnly?: boolean;
  wrap?: boolean;
  lineNumbers?: boolean;
  className?: string;
  placeholder?: string;
  /** Show JSON string values longer than this many characters as "… view more". */
  collapseStringsOver?: number;
  /** Extra key bindings, run before the defaults. */
  keys?: KeyBinding[];
  /** Receives the EditorView once created (for opening search from a toolbar button, etc.). */
  onView?: (view: EditorView) => void;
  /** Font size in px; 0 / undefined follows the editor font size. */
  fontSize?: number;
  /** Enables {{variable}} highlighting and autocomplete. */
  variables?: readonly VariableInfo[];
  /** Built-in undo history. Off when the owner keeps its own history (the request editor). Default true. */
  history?: boolean;
  /** JSON only: key / value suggestions (keys used by similar requests, common API keys). */
  jsonSuggestions?: readonly JsonKeySuggestion[];
  /** JSON only: double-click a key copies its value, double-click in a string selects its content. */
  copyValues?: boolean;
  /** Copy a mouse selection kept for two seconds (with a countdown toast). */
  holdToCopy?: boolean;
}

function CodeViewInner({
  value,
  onChange,
  language = 'text',
  readOnly,
  wrap,
  lineNumbers = true,
  className,
  placeholder,
  collapseStringsOver,
  keys,
  onView,
  fontSize,
  variables,
  jsonSuggestions,
  history = true,
  copyValues,
  holdToCopy,
}: CodeViewProps) {
  // Keep key handlers current without rebuilding extensions on every render.
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const hasKeys = !!keys?.length;
  const varsRef = useRef(variables);
  varsRef.current = variables;
  const hasVars = variables !== undefined;
  const jsonRef = useRef(jsonSuggestions);
  jsonRef.current = jsonSuggestions;
  const hasJsonSuggestions = jsonSuggestions !== undefined && language === 'json';
  const copyToast = useCopyAssistToast();
  const jsonCopy = !!copyValues && language === 'json';
  // Rebuild marks only when which keys resolve changes, not on every new context object.
  const varsKey = variables?.map((v) => (v.resolved ? v.key : `!${v.key}`)).join('\n') ?? '';
  const extensions = useMemo(() => {
    const sources = [...(hasVars ? [variableSource(varsRef)] : []), ...(hasJsonSuggestions ? [jsonSuggestionSource(jsonRef)] : [])];
    return [
      ...baseExtensions,
      ...languageExtension(language),
      // Highest precedence: vsTheme (earlier in the list) also sets the root font size.
      ...(fontSize ? [Prec.highest(EditorView.theme({ '&': { fontSize: `${fontSize}px` } }))] : []),
      ...(hasVars ? [variableMarks(varsRef), variableHover(varsRef)] : []),
      ...(sources.length ? [autocompletion({ override: sources, icons: false })] : []),
      ...(wrap ? [EditorView.lineWrapping] : []),
      ...(jsonCopy || holdToCopy ? [copyAssist(copyToast.handlers, { json: jsonCopy, hold: !!holdToCopy })] : []),
      ...(collapseStringsOver !== undefined && language === 'json' ? [collapseLongStrings(collapseStringsOver)] : []),
      ...(hasKeys
        ? [
            Prec.high(
              keymap.of(
                (keysRef.current ?? []).map((k, i) => ({
                  ...k,
                  run: (view: EditorView) => keysRef.current?.[i]?.run?.(view) ?? false,
                })),
              ),
            ),
          ]
        : []),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, wrap, collapseStringsOver, hasKeys, fontSize, hasVars, varsKey, hasJsonSuggestions, jsonCopy, holdToCopy]);
  const onCreateEditor = useCallback((view: EditorView) => onView?.(view), [onView]);
  return (
    <>
      <CodeMirror
        className={cx('cm-host min-h-0 overflow-hidden', className)}
        value={value}
        height="100%"
        theme="none"
        extensions={extensions}
        onChange={onChange}
        onCreateEditor={onCreateEditor}
        readOnly={readOnly}
        // Read-only views stay focusable so the cursor, selection and Cmd/Ctrl+F search work.
        editable
        placeholder={placeholder}
        basicSetup={{
          lineNumbers,
          foldGutter: lineNumbers,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: false,
          history,
          historyKeymap: history,
          searchKeymap: true,
        }}
      />
      {copyToast.element}
    </>
  );
}

export const CodeView = memo(CodeViewInner);
export { openSearchPanel };
export type { EditorView };
