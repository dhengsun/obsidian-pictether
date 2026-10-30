import { t } from '../core/i18n';
import { AssetResources } from './resources';
import { mountPdf } from './pdf-preview';

/** Capture clicks before the host handles a custom URI; Enter activates the same anchor. */
export function bindAssetLink(link:HTMLAnchorElement,uri:string,resources:AssetResources):()=>void {
  let alive=true,opening=false;
  let errorMessage:HTMLSpanElement|undefined;
  const onClick=(event:MouseEvent)=>{
    event.preventDefault();event.stopImmediatePropagation();
    if(opening)return;
    opening=true;errorMessage?.remove();
    void resources.open(uri).catch(()=>{
      if(alive){link.title=t("Could not open attachment. Check Assets Root, the file and its default application.");link.setAttribute('aria-label',link.title);errorMessage=link.ownerDocument.createElement('span');errorMessage.className='pictether-image-status';errorMessage.textContent=link.title;link.after(errorMessage);}
    }).finally(()=>{opening=false;});
  };
  link.addEventListener('click',onClick,true);
  return()=>{alive=false;errorMessage?.remove();link.removeEventListener('click',onClick,true);};
}
export function mountAssetLink(container:HTMLElement,uri:string,label:string,resources:AssetResources):()=>void {
  const link=container.createEl('a',{text:label || t("Attachment"),attr:{href:uri,title:t("Open with default application")}});
  return bindAssetLink(link,uri,resources);
}

export function mountAsset(container:HTMLElement,uri:string,alt:string,resources:AssetResources,onLayout:()=>void=()=>{}):()=>void {
  let alive=true,cleanup=()=>{},release=()=>{};
  container.classList.add('pictether-asset');
  const status=container.createSpan({text:t("Loading attachment…"),cls:'pictether-image-status'});
  try{
    const lease=resources.acquire(uri);release=lease.release;
    void lease.asset.then(asset=>{
      if(!alive)return;
      status.remove();
      if(asset.format.kind==='image'){
        container.classList.add('pictether-image');
        const sizing=/^(.*)\|(\d+)(?:x(\d+))?$/.exec(alt);
        const image=container.createEl('img',{attr:{src:asset.url,alt:sizing?.[1]??alt}});
        if(sizing){image.width=Math.min(10000,Number(sizing[2]));if(sizing[3])image.height=Math.min(10000,Number(sizing[3]));}
        image.addEventListener('load',onLayout,{once:true});
        image.addEventListener('error',()=>{if(alive){image.remove();container.createSpan({text:t("Cannot decode image: {0}", uri)});onLayout();}},{once:true});
        if(resources.preview){
          image.title=t('Click to preview');
          const onClick=(event:MouseEvent)=>{event.preventDefault();event.stopImmediatePropagation();resources.preview!(asset.url,image.alt);};
          image.addEventListener('click',onClick,true);
          cleanup=()=>{image.removeEventListener('click',onClick,true);};
        }
      }else{
        if(asset.format.kind==='file')container.classList.add('pictether-file');
        if(asset.format.kind==='video'){
          const video=container.createEl('video',{attr:{src:asset.url,preload:'metadata'}});video.controls=true;
          video.addEventListener('loadedmetadata',onLayout,{once:true});
          video.addEventListener('error',()=>{if(alive){container.createSpan({text:t("Video cannot play with the installed codecs. Use Open attachment.")});onLayout();}},{once:true});
          cleanup=()=>{video.pause();video.removeAttribute('src');video.load();};
        }else if(asset.format.kind==='pdf'){const viewer=container.createDiv({cls:'pictether-pdf'});cleanup=mountPdf(viewer,asset.url,onLayout);}
        const link=container.createEl('a',{text:asset.format.kind==='file' ? t("{0} (.{1}) — Open attachment", alt || t("Attachment"), asset.format.extension) : t("Open attachment"),attr:{href:uri,title:t("Open with default application")}});
        const unbind=bindAssetLink(link,uri,resources),disposeMedia=cleanup;
        cleanup=()=>{unbind();disposeMedia();};
      }
      onLayout();
    },()=>{if(alive){status.setText(t("Attachment unavailable: {0}. Check Assets Root or run Restore Missing Attachments.", uri));onLayout();}});
  }catch{status.setText(t('Invalid Pictether reference: {0}',uri));}
  return()=>{alive=false;cleanup();release();};
}
