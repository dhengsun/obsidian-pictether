import { editorLivePreviewField, MarkdownRenderChild, Plugin } from 'obsidian';
import { syntaxTree } from '@codemirror/language';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { Range } from '@codemirror/state';
import { isTextAsset } from './file-decorations';
import { parseReference } from '../core/references';
import { NativeImageBridge } from './native-images';

export { AssetResources, AssetResources as ImageResources } from './resources';
import { AssetResources as ImageResources } from './resources';
import { bindAssetLink, mountAsset, mountAssetLink } from './media-renderer';

class ReadingImage extends MarkdownRenderChild {
  private release = () => {};
  constructor(el: HTMLElement, private uri: string, private alt: string, private resources: ImageResources) { super(el); }
  onload(): void { this.release = mountAsset(this.containerEl, this.uri, this.alt, this.resources); }
  onunload(): void { this.release(); }
}
class ReadingLink extends MarkdownRenderChild {
  private release = () => {};
  constructor(private link: HTMLAnchorElement, private uri: string, private resources: ImageResources) { super(link); }
  onload(): void { this.release = bindAssetLink(this.link,this.uri,this.resources); }
  onunload(): void { this.release(); }
}
class ImageWidget extends WidgetType {
  private release = () => {};
  constructor(readonly uri: string, readonly alt: string, private resources: ImageResources, private embed = true) { super(); }
  eq(other: ImageWidget): boolean { return other.uri === this.uri && other.alt === this.alt && other.embed === this.embed; }
  toDOM(view: EditorView): HTMLElement {
    const el = view.dom.ownerDocument.createElement('span');
    this.release = this.embed ? mountAsset(el, this.uri, this.alt, this.resources, () => view.requestMeasure()) : mountAssetLink(el,this.uri,this.alt,this.resources);
    el.addEventListener('pictether-image-loaded', () => view.requestMeasure());
    return el;
  }
  destroy(): void { this.release(); }
  ignoreEvent(): boolean { return false; }
}
export function registerRendering(plugin: Plugin, resources: ImageResources): void {
  plugin.registerMarkdownPostProcessor((el, context) => {
    for (const link of el.querySelectorAll<HTMLAnchorElement>('a[href^="mdasset://"]')) {
      try { parseReference(link.getAttribute('href')!); } catch { continue; }
      context.addChild(new ReadingLink(link,link.getAttribute('href')!,resources));
    }
    for (const image of el.querySelectorAll<HTMLElement>('[src^="mdasset://"]')) {
      if(!el.contains(image))continue;
      const uri = image.getAttribute('src');
      if (!uri?.startsWith('mdasset://')) continue;
      try { parseReference(uri); } catch { continue; }
      const wrapper = image.ownerDocument.createElement('span');
      image.replaceWith(wrapper);
      const width = image.getAttribute('width');
      const description=image.getAttribute('alt')??'Attachment';
      const alt = width && !description.includes('|') ? `${description}|${width}` : description;
      context.addChild(new ReadingImage(wrapper, uri, alt, resources));
    }
  });
  plugin.registerEditorExtension([ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    private nativeImages: NativeImageBridge;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
      this.nativeImages = new NativeImageBridge(view.dom, resources, () => !!view.state.field(editorLivePreviewField, false), () => view.requestMeasure());
    }
    destroy(): void { this.nativeImages.dispose(); }
    update(update: ViewUpdate): void {
      this.nativeImages.refresh();
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false)) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
      const ranges: Range<Decoration>[] = [];
      for (const visible of view.visibleRanges) {
        const text = view.state.sliceDoc(visible.from, visible.to);
        const pattern = /(!?)\[([^\n]*?)\]\(<?(mdasset:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\)/g;
        for (const match of text.matchAll(pattern)) {
          try { parseReference(match[3]!); } catch { continue; }
          if (match[1] === '!' && isTextAsset(match[3]!)) continue;
          const from = visible.from + match.index!, to = from + match[0].length;
          let node = syntaxTree(view.state).resolveInner(from + 1, 1);
          let protectedText = false;
          for (let current: typeof node | null = node; current; current = current.parent) {
            if (/code|comment|frontmatter|math|htmlblock/i.test(current.name)) { protectedText = true; break; }
          }
          if (protectedText || view.state.selection.ranges.some(s => s.from <= to && s.to >= from)) continue;
          ranges.push(Decoration.replace({ widget: new ImageWidget(match[3]!, match[2]!, resources, match[1] === '!') }).range(from, to));
        }
      }
      return Decoration.set(ranges, true);
    }
  }, { decorations: value => value.decorations })]);
}
