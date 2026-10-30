// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountNativeMediaProxy, NATIVE_MEDIA_PROXY_SOURCE } from '../src/obsidian/file-decorations';
afterEach(()=>vi.unstubAllGlobals());
function fixture(){
  const host=document.createElement('div'),image=document.createElement('img'),content=document.createElement('span');
  image.src='mdasset://vault/2026-10-28/120000-abcdef.pdf';image.style.borderRadius='4px';
  content.textContent='PDF — Open attachment';host.append(image,content);document.body.appendChild(host);
  let width=360,height=28;
  content.getBoundingClientRect=()=>new DOMRect(0,0,width,height);
  // jsdom has no layout. This models the exact native read, keeping hidden nodes
  // at zero; actual browser geometry remains a separate Obsidian check.
  Object.defineProperty(image,'offsetHeight',{get:()=>image.hidden?0:parseFloat(image.style.height)||0});
  return{host,image,content,resize:(w:number,h:number)=>{width=w;height=h;}};
}
it('keeps the original image measurable before native load listeners reserve the source-preview space',()=>{
  const {image,content}=fixture(),onLayout=vi.fn();let reserved=0;
  image.addEventListener('load',()=>{if(!reserved)reserved=image.offsetHeight;});
  const proxy=mountNativeMediaProxy(image,content,onLayout);
  expect(image.hidden).toBe(false);expect(image.style.height).toBe('28px');expect(image.style.width).toBe('360px');
  expect(image.getAttribute('src')).toBe(NATIVE_MEDIA_PROXY_SOURCE);
  image.dispatchEvent(new Event('load'));expect(reserved).toBe(28);
  expect(image.style.opacity).toBe('0');expect(content.hidden).toBe(false);proxy.dispose();
});
it('does not depend on a mouseup, selection-head change or deferred editor transaction',()=>{
  const {host,image,content}=fixture();let held=true,reserved=0;
  host.addEventListener('mouseup',()=>{held=false;});
  image.addEventListener('load',()=>{reserved=image.offsetHeight;});
  host.dispatchEvent(new MouseEvent('mousedown',{buttons:1,bubbles:true}));
  const proxy=mountNativeMediaProxy(image,content,()=>{});
  image.dispatchEvent(new Event('load'));
  expect(held).toBe(true);expect(reserved).toBeGreaterThan(0);
  expect(host.querySelector('[data-pictether-source-gap],.pictether-file-edit')).toBeNull();proxy.dispose();
});
it('tracks renderer dimensions and restores the native node on cleanup without adding controls',()=>{
  let changed!:ResizeObserverCallback;const disconnect=vi.fn();
  vi.stubGlobal('ResizeObserver',class{constructor(callback:ResizeObserverCallback){changed=callback;}observe(){}disconnect=disconnect;});
  const {host,image,content,resize}=fixture(),source=image.getAttribute('src'),style=image.getAttribute('style');
  const controls=document.createElement('div');controls.innerHTML='<button>Zoom</button><button>Source</button>';host.appendChild(controls);
  const proxy=mountNativeMediaProxy(image,content,()=>{});
  resize(220,56);changed([],{} as ResizeObserver);
  expect(image.style.height).toBe('56px');expect(image.style.width).toBe('220px');
  expect(host.querySelectorAll('button')).toHaveLength(2);expect(controls.parentElement).toBe(host);
  proxy.dispose();expect(image.getAttribute('src')).toBe(source);expect(image.getAttribute('style')).toBe(style);
  expect(disconnect).toHaveBeenCalledOnce();expect(image.hidden).toBe(false);
});
it('does not overwrite a new URI assigned by the host while releasing an older proxy',()=>{
  const {image,content}=fixture(),proxy=mountNativeMediaProxy(image,content,()=>{});
  const next='mdasset://vault/2026-10-28/120001-abcdef.pdf';image.setAttribute('src',next);proxy.dispose();
  expect(image.getAttribute('src')).toBe(next);
});

