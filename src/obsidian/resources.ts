import { t } from '../core/i18n';
import { identifyAsset, AssetFormat } from '../core/assets';
import { parseReference } from '../core/references';
export interface AssetResource { url:string; format:AssetFormat; open?():Promise<void>; dispose?():void }
export type AssetLoader=(uri:string)=>Promise<Uint8Array|AssetResource>;
export class AssetResources {
  private cache=new Map<string,{promise:Promise<AssetResource>;users:number}>();
  constructor(private load:AssetLoader,readonly preview?:(url:string,alt:string,uri?:string)=>void){}
  acquire(uri:string):{url:Promise<string>;asset:Promise<AssetResource>;release():void}{
    parseReference(uri);
    let entry=this.cache.get(uri);
    if(!entry){
      const promise=this.load(uri).then(value=>{
        if(!ArrayBuffer.isView(value))return value as AssetResource;
        const format=identifyAsset(value,parseReference(uri).filename);
        const url=URL.createObjectURL(new Blob([Uint8Array.from(value).buffer],{type:format.mime}));
        return{url,format,dispose:()=>URL.revokeObjectURL(url)};
      });
      entry={promise,users:0};this.cache.set(uri,entry);
      void promise.catch(()=>{if(this.cache.get(uri)===entry)this.cache.delete(uri);});
    }
    entry.users++;
    let released=false;
    const url=entry.promise.then(asset=>asset.url);
    // Callers may consume asset metadata instead of the URL-only convenience promise.
    void url.catch(()=>{});
    return{url,asset:entry.promise,release:()=>{
      if(released)return;released=true;
      if(--entry.users===0){if(this.cache.get(uri)===entry)this.cache.delete(uri);void entry.promise.then(asset=>asset.dispose?.(),()=>{});}
    }};
  }
  async open(uri:string):Promise<void>{
    const lease=this.acquire(uri);
    try{const asset=await lease.asset;if(!asset.open)throw new Error(t("System opening is unavailable. Reload Pictether."));await asset.open();}
    finally{lease.release();}
  }
  dispose():void{for(const entry of this.cache.values())void entry.promise.then(asset=>asset.dispose?.(),()=>{});this.cache.clear();}
}
export { AssetResources as ImageResources };
