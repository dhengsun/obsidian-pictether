/** A native image load is Obsidian's signal to reserve source-preview height.
 * Preserve that public DOM/load contract for non-image attachments, rather than
 * hiding the image or writing to any private editor state. */
export const NATIVE_MEDIA_PROXY_SOURCE = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E';
export function isTextAsset(uri: string): boolean { return /\.md$/.test(uri); }

export function mountNativeMediaProxy(image: HTMLImageElement, content: HTMLElement, onLayout: () => void): { refresh(): void; dispose(): void } {
  const previousStyle = image.getAttribute('style'), previousSource = image.getAttribute('src');
  const previousHidden = image.hidden;
  let alive = true;
  image.hidden = false;
  image.classList.add('pictether-native-media-proxy');
  // The sibling stays in normal flow and determines the wrapper's dimensions.
  // The transparent image shares those dimensions without adding a second box.
  image.style.position = 'absolute';
  image.style.inset = '0';
  image.style.opacity = '0';
  image.style.pointerEvents = 'none';
  const refresh = () => {
    if (!alive) return;
    const rect = content.getBoundingClientRect();
    const lineHeight = parseFloat(image.ownerDocument.defaultView!.getComputedStyle(content).lineHeight) || 24;
    const width = `${Math.max(1, Math.ceil(rect.width || 80))}px`;
    const height = `${Math.max(1, Math.ceil(rect.height || lineHeight))}px`;
    const resized = image.style.width !== width || image.style.height !== height;
    image.style.width = width;
    image.style.height = height;
    // Size is set before src: native load listeners must never observe zero.
    if (image.getAttribute('src') !== NATIVE_MEDIA_PROXY_SOURCE) image.setAttribute('src', NATIVE_MEDIA_PROXY_SOURCE);
    else if (resized) image.dispatchEvent(new Event('load'));
    onLayout();
  };
  const Resize = image.ownerDocument.defaultView?.ResizeObserver;
  const observer = Resize ? new Resize(refresh) : undefined;
  observer?.observe(content);
  refresh();
  return { refresh, dispose() {
    if (!alive) return;
    alive = false; observer?.disconnect();
    image.classList.remove('pictether-native-media-proxy');
    image.hidden = previousHidden;
    if (previousStyle === null) image.removeAttribute('style'); else image.setAttribute('style', previousStyle);
    if (image.getAttribute('src') === NATIVE_MEDIA_PROXY_SOURCE) {
      if (previousSource === null) image.removeAttribute('src'); else image.setAttribute('src', previousSource);
    }
  } };
}

