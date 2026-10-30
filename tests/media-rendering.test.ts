// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AssetResources} from '../src/obsidian/resources';
import {mountAsset, mountAssetLink} from '../src/obsidian/media-renderer';
import {NativeImageBridge} from '../src/obsidian/native-images';
import {setPdfTestLibrary} from './obsidian-stub';
afterEach(()=>vi.restoreAllMocks());
const uri=(ext:string)=>`mdasset://vault/2026-10-28/120000-abcdef.${ext}`;
it('does not intercept or render retired JSON embeds',async()=>{
  const root=document.createElement('div'),image=document.createElement('img');document.body.appendChild(root);
  image.src=uri('json');root.appendChild(image);
  const load=vi.fn(),bridge=new NativeImageBridge(root,new AssetResources(load),()=>true,()=>{});
  await Promise.resolve();
  expect(load).not.toHaveBeenCalled();expect(image.getAttribute('src')).toBe(uri('json'));
  expect(root.querySelector('.pictether-asset')).toBeNull();bridge.dispose();
});
beforeEach(()=>{
  Object.assign(HTMLElement.prototype,{
    createSpan(this:HTMLElement,options:{text?:string;cls?:string}={}){const el=document.createElement('span');el.textContent=options.text??'';el.className=options.cls??'';this.appendChild(el);return el;},
    createDiv(this:HTMLElement,options:{cls?:string}={}){const el=document.createElement('div');el.className=options.cls??'';this.appendChild(el);return el;},
    createEl(this:HTMLElement,tag:string,options:{text?:string;attr?:Record<string,string>}={}){const el=document.createElement(tag);el.textContent=options.text??'';for(const[k,v]of Object.entries(options.attr??{}))el.setAttribute(k,v);this.appendChild(el);return el;},
    setText(this:HTMLElement,text:string){this.textContent=text;}
  });
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
});
it('previews a native image with its resolved URL and releases the click handler on disposal',async()=>{
  const root=document.createElement('div'),image=document.createElement('img');
  root.appendChild(image);image.src=uri('png');image.alt='External image';
  const preview=vi.fn(),host=vi.fn(),url='app://local/verified.png';
  root.addEventListener('click',host);
  const resources=new AssetResources(async()=>({url,format:{kind:'image',extension:'png',mime:'image/png'}}),preview);
  const bridge=new NativeImageBridge(root,resources,()=>true,()=>{});
  await vi.waitFor(()=>expect(image.getAttribute('src')).toBe(url));
  const event=new MouseEvent('click',{bubbles:true,cancelable:true});image.dispatchEvent(event);
  expect(preview).toHaveBeenCalledExactlyOnceWith(url,'External image');
  expect(event.defaultPrevented).toBe(true);expect(host).not.toHaveBeenCalled();
  bridge.dispose();image.click();
  expect(preview).toHaveBeenCalledTimes(1);expect(host).toHaveBeenCalledOnce();
  expect(image.getAttribute('src')).toBe(uri('png'));
});

it('previews renderer-created images using the same resolved resource',async()=>{
  const root=document.createElement('div'),preview=vi.fn(),url='app://local/verified.png';
  const resources=new AssetResources(async()=>({url,format:{kind:'image',extension:'png',mime:'image/png'}}),preview);
  const cleanup=mountAsset(root,uri('png'),'External image|200',resources);
  await vi.waitFor(()=>expect(root.querySelector('img')).not.toBeNull());
  root.querySelector('img')!.click();
  expect(preview).toHaveBeenCalledExactlyOnceWith(url,'External image');cleanup();
  root.querySelector('img')!.click();expect(preview).toHaveBeenCalledTimes(1);
});

it.each(['png','mp4','pdf','md'])('routes the native %s zoom action without intercepting source reveal',async extension=>{
  const root=document.createElement('div');
  root.innerHTML='<div class="image-embed"><div class="image-wrapper"><img alt="Managed"></div><div class="embed-actions"><div class="embed-action zoom"><svg class="lucide-zoom-in"><path></path></svg></div><div class="embed-action edit-block-button"><svg class="lucide-code-2"></svg></div></div></div>';
  const image=root.querySelector('img')!,zoom=root.querySelector<HTMLElement>('.zoom')!,source=root.querySelector<HTMLElement>('.edit-block-button')!;
  image.src=uri(extension);
  const preview=vi.fn(),nativeZoom=vi.fn(),nativeSource=vi.fn(),url=`app://local/verified.${extension}`;
  zoom.addEventListener('click',nativeZoom);source.addEventListener('click',nativeSource);
  const kind=extension==='png'?'image':extension==='mp4'?'video':extension==='pdf'?'pdf':'file';
  const resources=new AssetResources(async()=>({url,format:{kind,extension,mime:'test/type'}}),preview);
  const bridge=new NativeImageBridge(root,resources,()=>true,()=>{});
  await vi.waitFor(()=>expect(image.getAttribute('src')).toBe(extension==='png'?url:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E'));
  // A nested SVG path and a keyboard-generated click on the action both work.
  zoom.querySelector('path')!.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  if(extension==='png')expect(preview).toHaveBeenLastCalledWith(url,'Managed');
  else expect(preview).toHaveBeenLastCalledWith(url,'Managed',uri(extension));
  zoom.click();expect(preview).toHaveBeenCalledTimes(2);expect(nativeZoom).not.toHaveBeenCalled();
  source.click();expect(nativeSource).toHaveBeenCalledOnce();expect(preview).toHaveBeenCalledTimes(2);
  bridge.dispose();zoom.click();expect(nativeZoom).toHaveBeenCalledOnce();
  expect(preview).toHaveBeenCalledTimes(2);expect(image.getAttribute('src')).toBe(uri(extension));
});

it('leaves ordinary image controls alone and resolves late-added controls after a managed URI changes',async()=>{
  const root=document.createElement('div');
  const markup='<div class="image-embed"><div class="image-wrapper"><img></div><div class="embed-actions"><div class="embed-action"><svg class="lucide-zoom-in"></svg></div></div></div>';
  root.innerHTML=markup+markup;
  const [ordinary,managed]=[...root.querySelectorAll('img')];
  ordinary!.src='app://local/ordinary.png';managed!.src=uri('png');
  const preview=vi.fn(),host=vi.fn();root.addEventListener('click',host);
  let enabled=true;
  const resources=new AssetResources(async reference=>({url:`app://local/${reference.slice(reference.lastIndexOf('/')+1)}`,format:{kind:'image',extension:'png',mime:'image/png'}}),preview);
  const bridge=new NativeImageBridge(root,resources,()=>enabled,()=>{});
  await vi.waitFor(()=>expect(managed!.src).toContain('app://local/'));
  root.querySelector<HTMLElement>('.embed-action')!.click();
  expect(host).toHaveBeenCalledOnce();expect(preview).not.toHaveBeenCalled();
  const next='mdasset://vault/2026-10-28/120001-abcdef.png';managed!.src=next;
  const action=root.querySelectorAll('.embed-actions')[1]!;
  action.innerHTML='<div class="embed-action"><svg class="lucide-zoom-in"></svg></div>';
  await vi.waitFor(()=>expect(managed!.src).toBe('app://local/120001-abcdef.png'));
  action.querySelector<HTMLElement>('.embed-action')!.click();
  expect(preview).toHaveBeenCalledExactlyOnceWith('app://local/120001-abcdef.png','Attachment');
  enabled=false;bridge.refresh();
  await vi.waitFor(()=>expect(managed!.getAttribute('src')).toBe(next));
  action.querySelector<HTMLElement>('.embed-action')!.click();
  expect(preview).toHaveBeenCalledTimes(1);expect(host).toHaveBeenCalledTimes(2);bridge.dispose();
});

describe('media rendering boundaries',()=>{
  it('uses a verified local URL directly for video without fetching a whole-file blob',async()=>{
    const root=document.createElement('div'),url='app://local/verified.mp4';
    const resources=new AssetResources(async()=>({url,format:{kind:'video',extension:'mp4',mime:'video/mp4'}}));
    const cleanup=mountAsset(root,uri('mp4'),'Video',resources);
    await vi.waitFor(()=>expect(root.querySelector('video')?.getAttribute('src')).toBe(url));
    expect(root.querySelector('video')?.controls).toBe(true);expect(root.querySelector('video')?.preload).toBe('metadata');
    expect(root.querySelector('a')?.getAttribute('href')).toBe(uri('mp4'));
    cleanup();expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
  it.each(['md'])('shows %s as a file link without loading content or mounting a PDF',async extension=>{
    const root=document.createElement('div'),url=`app://local/verified.${extension}`;
    const resources=new AssetResources(async()=>({url,format:{kind:'file',extension,mime:'text/plain'}}));
    const cleanup=mountAsset(root,uri(extension),'<script>unsafe()</script>',resources);
    await vi.waitFor(()=>expect(root.querySelector('a')?.getAttribute('href')).toBe(uri(extension)));
    expect(root.textContent).toContain(`(.${extension})`);
    expect(root.querySelector('script,img,video,canvas')).toBeNull();cleanup();
  });
  it('renders SVG through img only, never as inline markup',async()=>{
    const root=document.createElement('div'),url='app://local/verified.svg';
    const resources=new AssetResources(async()=>({url,format:{kind:'image',extension:'svg',mime:'image/svg+xml'}}));
    const cleanup=mountAsset(root,uri('svg'),'Vector',resources);
    await vi.waitFor(()=>expect(root.querySelector('img')?.getAttribute('src')).toBe(url));
    expect(root.querySelector('svg')).toBeNull();expect(root.querySelector('script')).toBeNull();cleanup();
  });
  it('converts a host-created video widget and preserves its node for cleanup',async()=>{
    const root=document.createElement('div'),native=document.createElement('video');
    document.body.appendChild(root);native.src=uri('mp4');root.appendChild(native);
    const resources=new AssetResources(async()=>({url:'app://local/verified.mp4',format:{kind:'video',extension:'mp4',mime:'video/mp4'}}));
    const bridge=new NativeImageBridge(root,resources,()=>true,()=>{});
    await vi.waitFor(()=>expect(root.querySelector('.pictether-asset video')?.getAttribute('src')).toBe('app://local/verified.mp4'));
    expect(native.hidden).toBe(true);bridge.dispose();expect(native.hidden).toBe(false);expect(native.getAttribute('src')).toBe(uri('mp4'));
  });
  it('renders one PDF page at a time and supports navigation and disposal',async()=>{
    const context=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const cancelled=vi.fn(),destroy=vi.fn(async()=>{}),getPage=vi.fn(async(_pageNumber:number)=>({
      getViewport:({scale}:{scale:number})=>({width:320*scale,height:180*scale}),
      render:()=>({promise:Promise.resolve(),cancel:cancelled}),cleanup:vi.fn()
    }));
    const getDocument=vi.fn(()=>({promise:Promise.resolve({numPages:2,getPage,destroy}),destroy}));
    setPdfTestLibrary({getDocument});
    const root=document.createElement('div'),url='app://local/verified.pdf';
    const resources=new AssetResources(async()=>({url,format:{kind:'pdf',extension:'pdf',mime:'application/pdf'}}));
    const cleanup=mountAsset(root,uri('pdf'),'PDF',resources);
    await vi.waitFor(()=>expect(root.textContent).toContain('1 / 2'));
    expect(getDocument).toHaveBeenCalledWith({url,isEvalSupported:false});
    expect(root.querySelector('canvas')?.width).toBeGreaterThan(0);
    const next=[...root.querySelectorAll('button')].find(button=>button.textContent==='Next page')!;
    next.click();await vi.waitFor(()=>expect(root.textContent).toContain('2 / 2'));
    expect(getPage.mock.calls.map(call=>call[0])).toEqual([1,2]);
    cleanup();expect(cancelled).toHaveBeenCalled();expect(destroy).toHaveBeenCalled();context.mockRestore();
  });
});


it('restores a detached pending native widget so reinsertion can resolve it again',async()=>{
  const root=document.createElement('div'),image=document.createElement('img');document.body.appendChild(root);
  image.src=uri('md');root.appendChild(image);
  let finish!:(asset:{url:string;format:{kind:'file';extension:string;mime:string}})=>void;
  const pending=new Promise<{url:string;format:{kind:'file';extension:string;mime:string}}>(resolve=>{finish=resolve;});
  const resources=new AssetResources(async()=>pending),bridge=new NativeImageBridge(root,resources,()=>true,()=>{});
  await vi.waitFor(()=>expect(image.hasAttribute('src')).toBe(false));
  image.remove();
  await vi.waitFor(()=>expect(image.getAttribute('src')).toBe(uri('md')));
  root.appendChild(image);finish({url:'app://local/check.md',format:{kind:'file',extension:'md',mime:'text/markdown'}});
  await vi.waitFor(()=>expect(root.querySelector('.pictether-asset a')).not.toBeNull());
  expect(image.hidden).toBe(false);expect(image.classList.contains('pictether-native-media-proxy')).toBe(true);bridge.dispose();
});
it('opens a file only on activation through the supplied system opener and suppresses host navigation',async()=>{
  const root=document.createElement('div'),open=vi.fn(async()=>{}),host=vi.fn();
  const load=vi.fn(async()=>({url:'app://local/check.md',format:{kind:'file' as const,extension:'md',mime:'text/markdown'},open}));
  const resources=new AssetResources(load),cleanup=mountAssetLink(root,uri('md'),'config.md',resources);
  expect(load).not.toHaveBeenCalled();
  const link=root.querySelector('a')!;link.addEventListener('click',host);
  const event=new MouseEvent('click',{bubbles:true,cancelable:true});link.dispatchEvent(event);
  await vi.waitFor(()=>expect(open).toHaveBeenCalledOnce());
  expect(event.defaultPrevented).toBe(true);expect(host).not.toHaveBeenCalled();cleanup();
});


it('keeps adjacent legacy Markdown widgets in text flow and remeasures on resize',async()=>{
  const callbacks:ResizeObserverCallback[]=[],disconnects:ReturnType<typeof vi.fn>[]=[];
  class Resize {
    disconnect=vi.fn();observe=vi.fn();unobserve=vi.fn();
    constructor(callback:ResizeObserverCallback){callbacks.push(callback);disconnects.push(this.disconnect);}
  }
  vi.stubGlobal('ResizeObserver',Resize);
  const {readFileSync}=await import('node:fs');
  const style=document.createElement('style');style.textContent=readFileSync('styles.css','utf8');document.head.appendChild(style);
  const root=document.createElement('div');document.body.appendChild(root);
  for(let index=0;index<2;index++){
    const line=document.createElement('div'),host=document.createElement('span'),image=document.createElement('img');
    image.src=uri('md');host.appendChild(image);line.appendChild(host);root.appendChild(line);
  }
  const measure=vi.fn(),resources=new AssetResources(async()=>({url:'app://local/check.md',format:{kind:'file',extension:'md',mime:'text/markdown'}}));
  const bridge=new NativeImageBridge(root,resources,()=>true,measure);
  try{
    await vi.waitFor(()=>expect(root.querySelectorAll('.pictether-file-host a')).toHaveLength(2));
    const links=[...root.querySelectorAll('a')];
    expect(getComputedStyle(links[0]!).display).toBe('inline');
    expect(getComputedStyle(links[1]!).marginTop).toBe('0px');
    expect(callbacks).toHaveLength(2);measure.mockClear();
    callbacks[0]!([],{} as ResizeObserver);expect(measure).toHaveBeenCalledOnce();
    bridge.dispose();expect(root.querySelector('.pictether-file-host')).toBeNull();
    expect(disconnects.every(disconnect=>disconnect.mock.calls.length===1)).toBe(true);
  }finally{bridge.dispose();style.remove();vi.unstubAllGlobals();}
});

it('keeps ordinary and inline file previews compact, without padding native wrappers or source lines',async()=>{
  const {readFileSync}=await import('node:fs');
  const style=document.createElement('style');style.textContent=readFileSync('styles.css','utf8');document.head.appendChild(style);
  const root=document.createElement('div');
  root.innerHTML='<div class="cm-content"><div class="cm-line"><div class="image-wrapper"><img></div></div><div class="cm-line">Following sentence</div></div><div class="cm-image-reveal-tooltip"><div class="image-wrapper"><img></div></div>';
  document.body.appendChild(root);
  for(const image of root.querySelectorAll('img'))image.src=uri('md');
  const resources=new AssetResources(async()=>({url:'app://local/check.md',format:{kind:'file',extension:'md',mime:'text/markdown'}}));
  const bridge=new NativeImageBridge(root,resources,()=>true,()=>{});
  try{
    await vi.waitFor(()=>expect(root.querySelectorAll('.pictether-file-host a')).toHaveLength(2));
    const normal=root.querySelector<HTMLElement>('.cm-content .image-wrapper')!;
    const tooltip=root.querySelector<HTMLElement>('.cm-image-reveal-tooltip .image-wrapper')!;
    // No permanent row reservation. Expanded-source space belongs to the
    // CodeMirror StateField, independently of these normal preview wrappers.
    expect(['','0px']).toContain(getComputedStyle(normal).paddingBottom);
    expect(['','0px']).toContain(getComputedStyle(tooltip).paddingBottom);
    for(const line of root.querySelectorAll('.cm-line'))expect(['','0px']).toContain(getComputedStyle(line).paddingBottom);
    expect(root.querySelectorAll('a')).toHaveLength(2);
    bridge.dispose();expect(root.querySelector('.pictether-file-host')).toBeNull();
    expect(['','0px']).toContain(getComputedStyle(normal).paddingBottom);
  }finally{bridge.dispose();style.remove();}
});
