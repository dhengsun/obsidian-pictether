import { loadPdfJs } from 'obsidian';
interface PdfPage { getViewport(options:{scale:number}):{width:number;height:number}; render(options:{canvasContext:CanvasRenderingContext2D;viewport:{width:number;height:number}}):{promise:Promise<void>;cancel():void}; cleanup():void }
interface PdfDocument { numPages:number; getPage(page:number):Promise<PdfPage>; destroy():Promise<void> }
interface PdfLibrary { getDocument(options:{url:string;isEvalSupported:boolean}):{promise:Promise<PdfDocument>;destroy():Promise<void>} }
/** Render one page at a time through Obsidian's public PDF.js loader. */
export function mountPdf(root:HTMLElement,url:string,onLayout:()=>void):()=>void {
  let disposed=false,document:PdfDocument|undefined,loading:ReturnType<PdfLibrary['getDocument']>|undefined;
  let rendering:ReturnType<PdfPage['render']>|undefined,page:PdfPage|undefined,pageNumber=1,busy=false;
  const toolbar=root.createDiv({cls:'pictether-pdf-toolbar'});
  const previous=toolbar.createEl('button',{text:'Previous page'}),label=toolbar.createSpan({text:'Loading PDF…'}),next=toolbar.createEl('button',{text:'Next page'});
  const canvas=root.createEl('canvas'),status=root.createSpan();
  canvas.className='pictether-pdf-canvas';
  previous.disabled=next.disabled=true;
  const render=async()=>{
    if(!document||disposed||busy)return;
    busy=true;previous.disabled=next.disabled=true;
    try{
      page?.cleanup();page=await document.getPage(pageNumber);
      if(disposed)return;
      const original=page.getViewport({scale:1});
      const width=Math.min(900,root.clientWidth||700),viewport=page.getViewport({scale:Math.min(2,width/original.width)});
      canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      const context=canvas.getContext('2d');if(!context)throw new Error('Canvas is unavailable.');
      rendering=page.render({canvasContext:context,viewport});await rendering.promise;
      if(!disposed){label.setText(`${pageNumber} / ${document.numPages}`);status.setText('');onLayout();}
    }catch{if(!disposed)status.setText('Cannot render this PDF. Use the attachment link to open it.');}
    finally{busy=false;if(!disposed&&document){previous.disabled=pageNumber<=1;next.disabled=pageNumber>=document.numPages;}}
  };
  previous.addEventListener('click',()=>{if(!busy&&pageNumber>1){pageNumber--;void render();}});
  next.addEventListener('click',()=>{if(!busy&&document&&pageNumber<document.numPages){pageNumber++;void render();}});
  void(async()=>{
    const library=await loadPdfJs() as PdfLibrary;
    if(disposed)return;
    loading=library.getDocument({url,isEvalSupported:false});document=await loading.promise;
    if(disposed){await document.destroy();return;}
    await render();
  })().catch(()=>{if(!disposed){label.setText('PDF unavailable');status.setText('Could not load PDF. Use the attachment link to open it.');}});
  return()=>{disposed=true;rendering?.cancel();page?.cleanup();if(loading)void loading.destroy().catch(()=>{});};
}
