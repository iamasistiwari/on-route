// CodeMirror extension: shorten long JSON string values to "first N chars … view more".
// The full text stays in the document; only the display is replaced. A value expands when clicked,
// or while the cursor/selection touches it, so editing is never blocked.
import { syntaxTree } from '@codemirror/language';
import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';

const toggleEffect = StateEffect.define<{ pos: number; expand: boolean }>();

/** Start positions of string values the user expanded, mapped through edits. */
const expandedField = StateField.define<RangeSet<Decoration>>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(toggleEffect)) continue;
      set = e.value.expand
        ? set.update({ add: [Decoration.mark({}).range(e.value.pos, e.value.pos + 1)] })
        : set.update({ filter: (from) => from !== e.value.pos });
    }
    return set;
  },
});

function isExpanded(state: EditorState, pos: number): boolean {
  let found = false;
  state.field(expandedField).between(pos, pos + 1, (from) => {
    if (from === pos) found = true;
  });
  return found;
}

class MoreWidget extends WidgetType {
  constructor(
    readonly pos: number,
    readonly hidden: number,
  ) {
    super();
  }
  eq(other: MoreWidget) {
    return other.pos === this.pos && other.hidden === this.hidden;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span');
    el.className = 'cm-view-more';
    el.textContent = '…view more';
    el.title = `Show ${this.hidden} more characters`;
    el.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ effects: toggleEffect.of({ pos: this.pos, expand: true }) });
    };
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class LessWidget extends WidgetType {
  constructor(readonly pos: number) {
    super();
  }
  eq(other: LessWidget) {
    return other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span');
    el.className = 'cm-view-more';
    el.textContent = 'show less';
    el.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ effects: toggleEffect.of({ pos: this.pos, expand: false }) });
    };
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function build(view: EditorView, max: number): DecorationSet {
  const { state } = view;
  const sel = state.selection.ranges;
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'String') return;
        // Only values: skip property names.
        if (node.node.parent?.name === 'Property' && node.node.prevSibling === null) return;
        const inner = node.to - node.from - 2;
        if (inner <= max) return;
        const line = state.doc.lineAt(node.from);
        if (node.to > line.to) return;
        if (isExpanded(state, node.from)) {
          decos.push(Decoration.widget({ widget: new LessWidget(node.from), side: 1 }).range(node.to));
          return;
        }
        if (sel.some((r) => r.from <= node.to && r.to >= node.from)) return;
        const cut = node.from + 1 + max;
        decos.push(Decoration.replace({ widget: new MoreWidget(node.from, node.to - 1 - cut) }).range(cut, node.to - 1));
      },
    });
  }
  return Decoration.set(decos, true);
}

export function collapseLongStrings(max = 20): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, max);
      }
      update(u: ViewUpdate) {
        const expandChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(toggleEffect)));
        if (u.docChanged || u.viewportChanged || u.selectionSet || expandChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view, max);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [expandedField, plugin];
}
