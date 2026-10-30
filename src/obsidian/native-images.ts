import { t } from '../core/i18n';
import type { AssetResources as ImageResources } from './resources';
import { mountNativeMediaProxy, NATIVE_MEDIA_PROXY_SOURCE } from './file-decorations';
import { parseReference } from '../core/references';
import { mountAsset } from './media-renderer';

interface NativeImage {
  uri: string;
  url?: string;
  resolvedUrl?: string;
  media?: boolean;
  refreshSource?(): void;
  status: HTMLSpanElement;
  release(): void;
  detachEvents(): void;
}

/** Resolve host-created image widgets without replacing their DOM or Markdown. */
export class NativeImageBridge {
  private images = new Map<HTMLElement, NativeImage>();
  private observer: MutationObserver;
  private scheduled = false;
  private disposed = false;

  private onClick = (event: MouseEvent): void => {
    if (!this.enabled() || !this.resources.preview || event.button !== 0) return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    let image: HTMLElement | undefined;
    const direct = this.images.get(target as HTMLElement);
    if (direct && !direct.media) image = target as HTMLElement;
    else {
      // The host lightbox uses the Markdown URL, not the resolved IMG src.
      // Match only the zoom icon inside a managed native embed. Do not depend
      // on translated tooltips or intercept source-edit/resize controls.
      const action = target.closest('.embed-actions > .embed-action');
      if (!action?.querySelector('.lucide-zoom-in')) return;
      const embed = action.closest('.image-embed');
      if (!embed || !this.root.contains(embed)) return;
      image = [...this.images.keys()].find((node) => node.closest('.image-embed') === embed);
    }
    if (!image) return;
    const entry = this.images.get(image);
    if (!entry?.resolvedUrl || !this.root.contains(image)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const alt = image.getAttribute('alt') ?? t('Attachment');
    if (entry.media) this.resources.preview(entry.resolvedUrl, alt, entry.uri);
    else this.resources.preview(entry.resolvedUrl, alt);
  };

  constructor(
    private root: HTMLElement,
    private resources: ImageResources,
    private enabled: () => boolean,
    private measure: () => void,
  ) {
    const Observer = root.ownerDocument.defaultView!.MutationObserver;
    this.observer = new Observer(() => this.refresh());
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    root.addEventListener('click', this.onClick, true);
    this.refresh();
  }

  refresh(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = true;
    // The host draws native widgets after the ViewPlugin constructor/update.
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.disposed) this.scan();
    });
  }

  private scan(): void {
    for (const [image, entry] of this.images) {
      const source = image.getAttribute('src');
      if (
        !this.enabled() ||
        !this.root.contains(image) ||
        (source !== null && source !== entry.uri && source !== entry.url)
      )
        this.release(image, entry);
    }
    if (!this.enabled()) return;
    // Query rendered images only. No document scan and no private host classes/APIs.
    for (const image of this.root.querySelectorAll<HTMLElement>('[src^="mdasset://"]')) {
      const uri = image.getAttribute('src')!;
      try {
        parseReference(uri);
      } catch {
        continue;
      }
      const existing = this.images.get(image);
      if (existing) {
        // The host may assign the original URI again during a layout update.
        if (existing.refreshSource) existing.refreshSource();
        else if (existing.url && !existing.media) image.setAttribute('src', existing.url);
        else image.removeAttribute('src');
        continue;
      }
      const status = image.ownerDocument.adoptNode(createSpan());
      status.className = 'pictether-image-status';
      status.textContent = t('Loading image…');
      image.after(status);
      const entry: NativeImage = { uri, status, release: () => {}, detachEvents: () => {} };
      this.images.set(image, entry);
      image.removeAttribute('src');
      const active = () =>
        !this.disposed && this.images.get(image) === entry && this.root.contains(image);
      const failed = (message: string) => {
        if (!active()) return;
        status.textContent = message;
        image.after(status);
        this.measure();
      };
      const onLoad = () => {
        if (active()) {
          status.remove();
          this.measure();
        }
      };
      const onError = () => {
        if (entry.url && !entry.media) failed(t('Cannot decode image: {0}', uri));
      };
      image.addEventListener('load', onLoad);
      image.addEventListener('error', onError);
      entry.detachEvents = () => {
        image.removeEventListener('load', onLoad);
        image.removeEventListener('error', onError);
      };
      try {
        const lease = this.resources.acquire(uri);
        entry.release = () => lease.release();
        void lease.asset.then(
          (asset) => {
            const url = asset.url;
            if (!active()) return;
            entry.url = url;
            entry.resolvedUrl = url;
            entry.media = asset.format.kind !== 'image' || image.tagName !== 'IMG';
            if (!entry.media) image.setAttribute('src', url);
            else {
              const wrapper = image.ownerDocument.adoptNode(createSpan());
              const previousHidden = image.hidden;
              if (image.tagName !== 'IMG') image.hidden = true;
              image.after(wrapper);
              const host = image.parentElement;
              const file = asset.format.kind === 'file';
              if (file) host?.classList.add('pictether-file-host');
              const unmount = mountAsset(
                wrapper,
                uri,
                image.getAttribute('alt') ?? t('Attachment'),
                this.resources,
                this.measure,
              );
              const proxy =
                image.tagName === 'IMG'
                  ? mountNativeMediaProxy(image as HTMLImageElement, wrapper, this.measure)
                  : undefined;
              if (proxy) {
                entry.url = NATIVE_MEDIA_PROXY_SOURCE;
                entry.refreshSource = () => proxy.refresh();
              }
              const detach = entry.detachEvents.bind(entry);
              entry.detachEvents = () => {
                proxy?.dispose();
                detach();
                unmount();
                wrapper.remove();
                if (file) host?.classList.remove('pictether-file-host');
                image.hidden = previousHidden;
              };
            }
            status.remove();
            this.measure();
          },
          () =>
            failed(
              t(
                'Image unavailable: {0}. Check Assets Root or run Restore Missing Attachments.',
                uri,
              ),
            ),
        );
      } catch {
        failed(`Invalid Pictether reference: ${uri}`);
      }
    }
  }

  private release(image: HTMLElement, entry: NativeImage): void {
    this.images.delete(image);
    entry.detachEvents();
    entry.status.remove();
    // Preserve host behavior when disabling the plugin/Live Preview. Never touch the note.
    if (image.getAttribute('src') === entry.url || !image.hasAttribute('src'))
      image.setAttribute('src', entry.uri);
    entry.release();
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    this.root.removeEventListener('click', this.onClick, true);
    for (const [image, entry] of this.images) this.release(image, entry);
  }
}
