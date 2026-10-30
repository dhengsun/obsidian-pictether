// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, Extension, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { Editor, MarkdownFileInfo, Plugin } from 'obsidian';
import { editorInfoField } from './obsidian-stub';
import { ImportAnchors, supportedFile, selectImages } from '../src/obsidian/importing';
import { ImageResources } from '../src/obsidian/rendering';
const views: EditorView[] = [];
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { for (const view of views.splice(0)) view.destroy(); vi.unstubAllGlobals(); });
function setup(doc: string, from: number, to = from) {
  const extensions: Extension[] = [];
  const plugin = { registerEditorExtension: (extension: Extension) => extensions.push(extension), register: () => {} } as unknown as Plugin;
  const editor = {} as Editor;
  const file = { path: 'note.md' };
  const anchors = new ImportAnchors(plugin);
  const element = document.createElement('div'); document.body.appendChild(element);
  const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: [editorInfoField.init(() => ({ editor, file } as MarkdownFileInfo)), ...extensions] }), parent: element });
  views.push(view);
  return { view, anchors, editor };
}
describe('async import anchors using real CM transactions', () => {
  it('keeps insertion at the original location while normal typing continues', () => {
    const { view, anchors, editor } = setup('before after', 7);
    const insertion = anchors.capture(editor);
    view.dispatch({ changes: { from: 7, insert: 'typed ' } });
    insertion.insert('![Image](mdasset://asset)\n');
    expect(view.state.doc.toString()).toBe('before ![Image](mdasset://asset)\ntyped after');
  });
  it('preserves text edited inside the original selection', () => {
    const { view, anchors, editor } = setup('prefix selected suffix', 7, 15);
    const insertion = anchors.capture(editor);
    view.dispatch({ changes: { from: 8, insert: 'new' } });
    insertion.insert('IMAGE');
    expect(view.state.doc.toString()).toBe('prefix IMAGEsnewelected suffix');
  });
  it('replaces an unchanged selection only after saving', () => {
    const { view, anchors, editor } = setup('a selected z', 2, 10);
    const insertion = anchors.capture(editor);
    expect(view.state.doc.toString()).toBe('a selected z');
    insertion.insert('IMAGE');
    expect(view.state.doc.toString()).toBe('a IMAGE z');
  });
  it('cancels without writing an invalid reference', () => {
    const { view, anchors, editor } = setup('unchanged', 0);
    anchors.capture(editor).cancel();
    expect(view.state.doc.toString()).toBe('unchanged');
  });
  it('does not insert into a detached editor', () => {
    const { view, anchors, editor } = setup('original', 0);
    const insertion = anchors.capture(editor);
    view.dom.remove();
    expect(() => insertion.insert('IMAGE')).toThrow('closed or changed');
    expect(view.state.doc.toString()).toBe('original');
  });
  it('does not steal a caret moved elsewhere while saving', () => {
    const { view, anchors, editor } = setup('before after', 7);
    const insertion = anchors.capture(editor);
    view.dispatch({ selection: { anchor: 2 } });
    insertion.insert('IMAGE\n');
    expect(view.state.selection.main.head).toBe(2);
  });
  it('preserves the typing position when text was entered while saving', () => {
    const { view, anchors, editor } = setup('before after', 7);
    const insertion = anchors.capture(editor);
    view.dispatch({ changes: { from: 7, insert: 'typed ' }, selection: { anchor: 13 } });
    insertion.insert('IMAGE\n');
    expect(view.state.doc.toString()).toBe('before IMAGE\ntyped after');
    expect(view.state.selection.main.head).toBe(19);
  });
});
it('shares in-flight image loads and revokes blobs when the last view releases them', async () => {
  const create = vi.fn(() => 'blob:test'), revoke = vi.fn();
  URL.createObjectURL = create; URL.revokeObjectURL = revoke;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
  const load = vi.fn(async () => png);
  const resources = new ImageResources(load);
  const uri = 'mdasset://vault/2026-10-26/3cf6dc21-d697-4ad5-bf16-cf29de29cb65.png';
  const a = resources.acquire(uri), b = resources.acquire(uri);
  expect(await a.url).toBe('blob:test'); await b.url;
  expect(load).toHaveBeenCalledTimes(1);
  a.release(); expect(revoke).not.toHaveBeenCalled();
  b.release(); await Promise.resolve(); expect(revoke).toHaveBeenCalledWith('blob:test');
});

describe('view rendering at the public Obsidian boundary', () => {
  function domHelpers() {
    Object.assign(HTMLElement.prototype, {
      createSpan(this: HTMLElement, options: { text?: string }) { const el = document.createElement('span'); el.textContent = options.text ?? ''; this.appendChild(el); return el; },
      createEl(this: HTMLElement, tag: string, options: { attr?: Record<string, string> }) { const el = document.createElement(tag); for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value); this.appendChild(el); return el; },
      setText(this: HTMLElement, text: string) { this.textContent = text; }
    });
    URL.createObjectURL = vi.fn(() => 'blob:render-test'); URL.revokeObjectURL = vi.fn();
  }
  it('renders custom references in Live Preview, keeps code literal, and reveals source on selection', async () => {
    domHelpers();
    const { Language, defineLanguageFacet } = await import('@codemirror/language');
    const { assetMarkdownParser } = await import('../src/core/markdown');
    const { editorLivePreviewField } = await import('./obsidian-stub');
    const { registerRendering } = await import('../src/obsidian/rendering');
    const extensions: Extension[] = [];
    const plugin = { registerEditorExtension: (extension: Extension) => extensions.push(extension), registerMarkdownPostProcessor: () => {} } as unknown as Plugin;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
    registerRendering(plugin, new ImageResources(async () => png));
    const uri = 'mdasset://vault/2026-10-26/3cf6dc21-d697-4ad5-bf16-cf29de29cb65.png';
    const doc = `Header\n\n![alt|200](${uri})\n\n\`![code](${uri})\`\n`;
    const parent = document.createElement('div'); document.body.appendChild(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: 0 }, extensions: [editorLivePreviewField, new Language(defineLanguageFacet(), assetMarkdownParser), ...extensions] }) });
    views.push(view);
    await vi.waitFor(() => expect(view.dom.querySelectorAll('.pictether-image img')).toHaveLength(1));
    expect(view.dom.querySelector('.pictether-image img')?.outerHTML).toContain('width="200"');
    view.dispatch({ selection: { anchor: doc.indexOf('![alt') + 2 } });
    expect(view.dom.querySelector('.pictether-image')).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });
  it('shows an imported image immediately and leaves the caret on the following line', async () => {
    domHelpers();
    const { Language, defineLanguageFacet } = await import('@codemirror/language');
    const { assetMarkdownParser } = await import('../src/core/markdown');
    const { editorLivePreviewField } = await import('./obsidian-stub');
    const { registerRendering } = await import('../src/obsidian/rendering');
    const extensions: Extension[] = [];
    const plugin = {
      registerEditorExtension: (extension: Extension) => extensions.push(extension),
      registerMarkdownPostProcessor: () => {}, register: () => {}
    } as unknown as Plugin;
    const editor = {} as Editor;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
    const load = vi.fn(async () => png);
    registerRendering(plugin, new ImageResources(load));
    const anchors = new ImportAnchors(plugin);
    const parent = document.createElement('div'); document.body.appendChild(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: [
      editorInfoField.init(() => ({ editor, file: { path: 'note.md' } } as MarkdownFileInfo)),
      editorLivePreviewField, new Language(defineLanguageFacet(), assetMarkdownParser), ...extensions
    ] }) });
    views.push(view);
    const uri = 'mdasset://%E6%8F%92%E4%BB%B6%E6%B5%8B%E8%AF%95/2026-10-27/3d5e81f1-c64f-4ee3-a28a-486af11eaa0e.png';
    const markdown = `![Image](${uri})\n`;
    anchors.capture(editor).insert(markdown);
    expect(view.state.selection.main.head).toBe(markdown.length);
    await vi.waitFor(() => expect(view.dom.querySelector('.pictether-image img')).not.toBeNull());
    expect(load).toHaveBeenCalledWith(uri);
  });
  it('resolves images already replaced by Obsidian native Live Preview widgets', async () => {
    domHelpers();
    const { editorLivePreviewField } = await import('./obsidian-stub');
    const { registerRendering } = await import('../src/obsidian/rendering');
    const uri = 'mdasset://%E6%8F%92%E4%BB%B6%E6%B5%8B%E8%AF%95/2026-10-27/fbb752ad-779a-4958-b232-1f645a3877f3.png';
    class NativeImageWidget extends WidgetType {
      toDOM() {
        const el = document.createElement('div');
        el.className = 'image-embed'; el.contentEditable = 'false';
        el.innerHTML = `<div class="image-wrapper"><img src="${uri}" alt="Image"></div><div class="embed-actions"><div class="embed-action"><svg class="lucide-zoom-in"></svg></div><div class="embed-action edit-block-button"><svg class="lucide-code-2"></svg></div></div>`;
        return el;
      }
    }
    const native = StateField.define<DecorationSet>({
      create: () => Decoration.set([Decoration.widget({ widget: new NativeImageWidget() }).range(0)]),
      update: value => value, provide: field => EditorView.decorations.from(field)
    });
    const extensions: Extension[] = [];
    const plugin = { registerEditorExtension: (extension: Extension) => extensions.push(extension), registerMarkdownPostProcessor: () => {} } as unknown as Plugin;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
    const load = vi.fn(async () => png);
    const preview = vi.fn();
    registerRendering(plugin, new ImageResources(load, preview));
    const parent = document.createElement('div'); document.body.appendChild(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: 'native widget', extensions: [editorLivePreviewField, native, ...extensions] }) });
    views.push(view);
    await vi.waitFor(() => expect(view.dom.querySelector('.image-wrapper img')?.getAttribute('src')).toBe('blob:render-test'));
    expect(load).toHaveBeenCalledWith(uri);
    expect(view.dom.querySelector('.image-embed .image-wrapper')).not.toBeNull();
    view.dom.querySelector<HTMLElement>('.embed-actions .embed-action')!.click();
    expect(preview).toHaveBeenCalledExactlyOnceWith('blob:render-test', 'Image');
    const source = view.dom.querySelector<HTMLElement>('.edit-block-button')!, reveal = vi.fn();
    source.addEventListener('click', reveal);source.click();
    expect(reveal).toHaveBeenCalledOnce();expect(preview).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe('native widget');
  });
  it('Reading View postprocessor uses the same loader and releases its resource', async () => {
    domHelpers();
    const { registerRendering } = await import('../src/obsidian/rendering');
    type Child = { onload(): void; onunload(): void };
    let postprocess!: (el: HTMLElement, context: { addChild(child: Child): void }) => void;
    const plugin = { registerEditorExtension: () => {}, registerMarkdownPostProcessor: (fn: typeof postprocess) => { postprocess = fn; } } as unknown as Plugin;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
    registerRendering(plugin, new ImageResources(async () => png));
    const el = document.createElement('div');
    el.innerHTML = '<img alt="sample" src="mdasset://vault/2026-10-26/3cf6dc21-d697-4ad5-bf16-cf29de29cb65.png"><img src="https://example.com/normal.png">';
    const children: Child[] = [];
    postprocess(el, { addChild(child) { children.push(child); child.onload(); } });
    await vi.waitFor(() => expect(el.querySelector('.pictether-image img')?.getAttribute('src')).toBe('blob:render-test'));
    expect(el.querySelector('img[src="https://example.com/normal.png"]')).not.toBeNull();
    children[0]!.onunload(); await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:render-test');
  });
});

describe('native image bridge lifecycle', () => {
  const uri = 'mdasset://vault/2026-10-27/fbb752ad-779a-4958-b232-1f645a3877f3.png';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64');
  function fixture() {
    URL.createObjectURL = vi.fn(() => 'blob:native'); URL.revokeObjectURL = vi.fn();
    const root = document.createElement('div'); document.body.appendChild(root);
    const image = document.createElement('img'); image.src = uri;
    return { root, image };
  }
  it('handles asynchronously created widgets and host URI reassignment without repeated reads', async () => {
    const { NativeImageBridge } = await import('../src/obsidian/native-images');
    const { root, image } = fixture();
    const load = vi.fn(async () => png);
    const bridge = new NativeImageBridge(root, new ImageResources(load), () => true, () => {});
    await Promise.resolve();
    root.appendChild(image);
    await vi.waitFor(() => expect(image.getAttribute('src')).toBe('blob:native'));
    image.src = uri;
    await vi.waitFor(() => expect(image.getAttribute('src')).toBe('blob:native'));
    expect(load).toHaveBeenCalledTimes(1);
    bridge.dispose();
    expect(image.getAttribute('src')).toBe(uri);
    await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:native');
  });
  it('releases resources after a native widget leaves the DOM', async () => {
    const { NativeImageBridge } = await import('../src/obsidian/native-images');
    const { root, image } = fixture(); root.appendChild(image);
    const bridge = new NativeImageBridge(root, new ImageResources(async () => png), () => true, () => {});
    await vi.waitFor(() => expect(image.getAttribute('src')).toBe('blob:native'));
    image.remove();
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:native'));
    bridge.dispose();
  });
  it('shows a concrete missing-image status without retry loops', async () => {
    const { NativeImageBridge } = await import('../src/obsidian/native-images');
    const { root, image } = fixture(); root.appendChild(image);
    const load = vi.fn(async (): Promise<Uint8Array> => { throw new Error('missing'); });
    const bridge = new NativeImageBridge(root, new ImageResources(load), () => true, () => {});
    await vi.waitFor(() => expect(root.querySelector('.pictether-image-status')?.textContent).toContain('Image unavailable:'));
    expect(root.querySelector('.pictether-image-status')?.textContent).toContain(uri);
    expect(image.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });
  it('leaves Source Mode and ordinary image URLs untouched', async () => {
    const { NativeImageBridge } = await import('../src/obsidian/native-images');
    const { root, image } = fixture(); root.appendChild(image);
    const normal = document.createElement('img'); normal.src = 'https://example.com/normal.png'; root.appendChild(normal);
    const load = vi.fn(async () => png);
    let enabled = false;
    const bridge = new NativeImageBridge(root, new ImageResources(load), () => enabled, () => {});
    await Promise.resolve();
    expect(image.getAttribute('src')).toBe(uri); expect(load).not.toHaveBeenCalled();
    enabled = true; bridge.refresh();
    await vi.waitFor(() => expect(image.getAttribute('src')).toBe('blob:native'));
    enabled = false; bridge.refresh();
    await vi.waitFor(() => expect(image.getAttribute('src')).toBe(uri));
    expect(normal.getAttribute('src')).toBe('https://example.com/normal.png');
    bridge.dispose();
  });
});


describe('file routing and picker', () => {
  it.each([
    ['PHOTO.JPG', 'application/octet-stream'], ['photo.jpeg', 'image/jpg'],
    ['photo.jpg', 'image/pjpeg'], ['clipboard', 'image/jpg'],
    ['photo.bmp', 'image/x-ms-bmp'], ['photo.avif', 'image/avif']
  ])('routes %s (%s) to content validation', (name, type) => {
    expect(supportedFile(new File(['bytes'], name, { type }))).toBe(true);
  });
  it('leaves ordinary non-image files to the native handler', () => {
    expect(supportedFile(new File(['text'], 'note.txt', { type: 'text/plain' }))).toBe(false);
    expect(supportedFile(new File(['svg'], 'image.svg', { type: 'image/svg+xml' }))).toBe(true);
  });
  it('lets the picker select jpg/jpeg aliases and new formats', () => {
    let accept = '';
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function(this: HTMLInputElement) { accept = this.accept; });
    selectImages(document, () => {}, () => {});
    expect(accept.split(',')).toEqual(expect.arrayContaining(['image/jpeg','.jpg','.jpeg','image/bmp','.bmp','image/avif','.avif']));
    click.mockRestore();
  });
});


it('leaves Markdown files to Obsidian even with a misleading MIME and excludes them from the picker',()=>{
  expect(supportedFile(new File(['# Note'],'README.md',{type:'text/markdown'}))).toBe(false);
  expect(supportedFile(new File(['# Note'],'README.MD',{type:'application/json'}))).toBe(false);
  expect(supportedFile(new File(['{}'],'config.json',{type:'application/json'}))).toBe(false);
  expect(supportedFile(new File(['{}'],'config.json',{type:'image/png'}))).toBe(false);
  const create=document.createElement.bind(document),input=create('input');
  vi.spyOn(document,'createElement').mockReturnValueOnce(input);
  vi.spyOn(input,'click').mockImplementation(()=>{});
  selectImages(document,()=>{},()=>{});
  expect(input.accept.split(',')).not.toContain('.md');
  expect(input.accept.split(',')).not.toContain('text/markdown');
  expect(input.accept.split(',')).not.toContain('.json');
  vi.restoreAllMocks();
});
