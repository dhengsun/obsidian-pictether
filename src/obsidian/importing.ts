import { Editor, editorInfoField, Plugin } from 'obsidian';
import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { randomUUID } from 'node:crypto';
import { ASSET_EXTENSIONS, ASSET_MIMES } from '../core/assets';

interface Anchor { from: number; to: number; original: string }
const addAnchor = StateEffect.define<{ id: string; anchor: Anchor }>();
const removeAnchor = StateEffect.define<string>();
const anchors = StateField.define<Map<string, Anchor>>({
  create: () => new Map(),
  update(value, tr) {
    const next = new Map<string, Anchor>();
    if (tr.startState.field(editorInfoField, false)?.file !== tr.state.field(editorInfoField, false)?.file) return next;
    for (const [id, a] of value) next.set(id, { ...a, from: tr.changes.mapPos(a.from, -1), to: tr.changes.mapPos(a.to, 1) });
    for (const effect of tr.effects) {
      if (effect.is(addAnchor)) next.set(effect.value.id, effect.value.anchor);
      if (effect.is(removeAnchor)) next.delete(effect.value);
    }
    return next;
  }
});
export interface Insertion { insert(markdown: string): void; cancel(): void }
/** Public editorInfoField bridges Obsidian Editor to its registered CM extension. */
export class ImportAnchors {
  private views = new Map<Editor, EditorView>();
  constructor(plugin: Plugin) {
    const views = this.views;
    plugin.registerEditorExtension([anchors, ViewPlugin.fromClass(class {
      private editor?: Editor;
      constructor(private view: EditorView) { this.bind(); }
      private bind() {
        const editor = this.view.state.field(editorInfoField, false)?.editor;
        if (this.editor !== editor && this.editor) views.delete(this.editor);
        this.editor = editor;
        if (editor) views.set(editor, this.view);
      }
      update(_update: ViewUpdate) { this.bind(); }
      destroy() { if (this.editor && views.get(this.editor) === this.view) views.delete(this.editor); }
    })]);
    plugin.register(() => views.clear());
  }
  capture(editor: Editor, coords?: { x: number; y: number }): Insertion {
    const view = this.views.get(editor);
    if (!view) throw new Error('Open a Markdown editor before inserting an image.');
    const selected = view.state.selection.main;
    const drop = coords ? view.posAtCoords(coords) : null;
    const from = drop ?? selected.from, to = drop ?? selected.to;
    const id = randomUUID();
    const file = view.state.field(editorInfoField, false)?.file;
    view.dispatch({ effects: addAnchor.of({ id, anchor: { from, to, original: view.state.sliceDoc(from, to) } }) });
    let used = false;
    return {
      insert(markdown) {
        if (used) throw new Error('Insertion already consumed.');
        used = true;
        const a = view.state.field(anchors).get(id);
        if (!a || !view.dom.isConnected || view.state.field(editorInfoField, false)?.file !== file) throw new Error('Editor was closed or changed notes. Image is saved; use its reference to insert it again.');
        const end = view.state.sliceDoc(a.from, a.to) === a.original ? a.to : a.from;
        const selection = view.state.selection;
        const unchangedSelection = selection.ranges.length === 1 && selection.main.from === a.from && selection.main.to === a.to && end === a.to;
        // CM maps an unspecified caret to before inserted text. At the image's
        // opening marker this deliberately selects source instead of preview.
        // Advance only a selection the user has not moved/edited during saving.
        view.dispatch({
          changes: { from: a.from, to: end, insert: markdown },
          selection: unchangedSelection ? { anchor: a.from + markdown.length } : undefined,
          scrollIntoView: unchangedSelection,
          effects: removeAnchor.of(id)
        });
      },
      cancel() { if (!used && view.dom.isConnected) view.dispatch({ effects: removeAnchor.of(id) }); used = true; }
    };
  }
}
export function supportedFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  // Text attachments belong to the native importer, regardless of an unreliable MIME.
  if (extension === 'md' || extension === 'json') return false;
  // Files from some apps have image/jpg or generic MIME types. Content is
  // validated before writing, so a filename is only a routing hint here.
  return [...ASSET_MIMES, 'image/jpg', 'image/pjpeg', 'image/x-bmp', 'image/x-ms-bmp'].includes(mime) || ASSET_EXTENSIONS.includes(extension);
}
export function selectImages(doc: Document, onFiles: (files: File[]) => void, onCancel: () => void): void {
  const input = doc.createElement('input');
  input.type = 'file'; input.accept = [...ASSET_MIMES, ...ASSET_EXTENSIONS.map(ext => `.${ext}`)].join(','); input.multiple = true;
  input.addEventListener('change', () => { const files = Array.from(input.files ?? []); if (files.length) onFiles(files); else onCancel(); }, { once: true });
  input.addEventListener('cancel', onCancel, { once: true });
  input.click();
}
