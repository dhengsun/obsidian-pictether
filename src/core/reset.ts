import { t } from './i18n';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { validateNamespace, validateRecordKey } from './references';

export class LocalResetError extends Error {}
interface ResetEntry { key:string; kind:'file'|'directory'; identity:string; attachment:boolean }
export interface LocalResetPlan {
  root:string; fingerprint:string; files:number; namespaces:number; unknown:number;
  entries:ResetEntry[]; rootIdentity:string;
}
function inside(parent:string,child:string):boolean {
  const relative=path.relative(parent,child);
  return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}
function missing(error:unknown):boolean{return (error as NodeJS.ErrnoException)?.code==='ENOENT';}
async function canonical(file:string):Promise<string>{
  try{return await fs.realpath(file);}catch(error){if(!missing(error))throw error;const parent=path.dirname(file);if(parent===file)throw error;return path.join(await canonical(parent),path.basename(file));}
}
async function safeRoot(root:string,protectedPaths:string[]):Promise<string>{
  if(!path.isAbsolute(root))throw new LocalResetError(t("重置已停止：附件根目录必须是绝对路径。"));
  const resolved=await canonical(root),home=await canonical(os.homedir());
  if(resolved===path.parse(resolved).root||inside(resolved,home))throw new LocalResetError(t("重置已停止：不能清理系统根目录或用户主目录。"));
  for(const protectedPath of protectedPaths){
    const target=await canonical(protectedPath);
    if(inside(resolved,target)||inside(target,resolved))throw new LocalResetError(t("重置已停止：附件目录不能包含笔记库，也不能位于笔记库或插件目录内。"));
  }
  // An explicitly configured symlink is never a deletion target.
  try{if((await fs.lstat(root)).isSymbolicLink())throw new LocalResetError(t("重置已停止：附件根目录是符号链接。"));}catch(error){if(!missing(error))throw error;}
  return resolved;
}
async function identity(file:string,kind:ResetEntry['kind']):Promise<string>{
  const value=await fs.lstat(file,{bigint:true});
  if(value.isSymbolicLink()||(kind==='file'?!value.isFile():!value.isDirectory()))throw new LocalResetError(t("重置已停止：受管理路径中存在符号链接或异常文件类型。"));
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}
function managed(key:string):boolean{try{validateRecordKey(key);return true;}catch{return false;}}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Read-only review. Unknown entries are counted and never traversed/deleted. */
export async function scanLocalReset(root:string,protectedPaths:string[]):Promise<LocalResetPlan>{
  const resolved=await safeRoot(root,protectedPaths),entries:ResetEntry[]=[],unknown:string[]=[],namespaces=new Set<string>();
  let rootIdentity='missing';
  try{rootIdentity=await identity(resolved,'directory');}catch(error){if(!missing(error))throw error;}
  const add=async(key:string,kind:ResetEntry['kind'],attachment=false)=>{entries.push({key,kind,attachment,identity:await identity(path.join(resolved,key),kind)});};
  const walk=async(key:string,level:'root'|'namespace'|'date'|'meta'|'claims'|'staging')=>{
    const handle=await fs.opendir(path.join(resolved,key));
    for await(const item of handle){
      const child=key?`${key}/${item.name}`:item.name;
      if(level==='root'){
        if(item.name==='.pictether'){await add(child,'directory');await walk(child,'meta');continue;}
        let valid=true;try{validateNamespace(item.name);}catch{valid=false;}
        if(valid&&item.isDirectory()){
          const start=entries.length;
          await add(child,'directory');await walk(child,'namespace');
          if(entries.length===start+1){entries.splice(start,1);unknown.push(child);}
          continue;
        }
      }else if(level==='namespace'){
        if(/^\d{4}-\d{2}-\d{2}$/.test(item.name)&&managed(`${child}/120000-abcdef.png`)){await add(child,'directory');await walk(child,'date');continue;}
      }else if(level==='date'&&managed(child)){
        await add(child,'file',true);namespaces.add(child.split('/')[0]!);continue;
      }else if(level==='meta'&&['namespaces','staging'].includes(item.name)){
        await add(child,'directory');await walk(child,item.name==='namespaces'?'claims':'staging');continue;
      }else if(level==='staging'&&uuid.test(item.name)){
        await add(child,'file');continue;
      }else if(level==='claims'&&item.name.endsWith('.json')){
        let valid=true;try{validateNamespace(item.name.slice(0,-5));}catch{valid=false;}
        if(valid){await add(child,'file');continue;}
      }
      if(item.isSymbolicLink())throw new LocalResetError(t("重置已停止：附件目录中存在符号链接，请先人工检查。"));
      unknown.push(child);
    }
  };
  if(rootIdentity!=='missing')await walk('','root');
  entries.sort((a,b)=>a.key.localeCompare(b.key));unknown.sort();
  const fingerprint=createHash('sha256').update(JSON.stringify([resolved,rootIdentity,entries,unknown])).digest('hex');
  return {root:resolved,rootIdentity,entries,fingerprint,files:entries.filter(entry=>entry.attachment).length,namespaces:namespaces.size,unknown:unknown.length};
}
/** Called only after UI confirmation and quiescing plugin work. Never touches OSS. */
export async function clearLocalAttachments(plan:LocalResetPlan,protectedPaths:string[]):Promise<LocalResetPlan>{
  const current=await scanLocalReset(plan.root,protectedPaths);
  if(current.fingerprint!==plan.fingerprint)throw new LocalResetError(t("本地附件范围已变化，请重新打开重置确认框。"));
  const directories=plan.entries.filter(entry=>entry.kind==='directory').sort((a,b)=>b.key.split('/').length-a.key.split('/').length);
  const anchors=new Map<string,string>([['',plan.rootIdentity],...directories.map(entry=>[entry.key,entry.identity] as const)]);
  const verifyParents=async(key:string)=>{
    let parent=path.posix.dirname(key);
    for(;;){
      const relative=parent==='.'?'':parent,expected=anchors.get(relative);
      const actual=await identity(path.join(plan.root,relative),'directory');
      // Directory contents change during our own unlink operations; dev/inode must remain fixed.
      if(!expected||actual.split(':').slice(0,2).join(':')!==expected.split(':').slice(0,2).join(':'))throw new LocalResetError(t("重置已停止：附件目录身份发生变化。"));
      if(!relative)break;parent=path.posix.dirname(relative);
    }
  };
  let count=0;
  for(const entry of plan.entries){
    if(entry.kind!=='file')continue;
    await verifyParents(entry.key);
    const file=path.join(plan.root,entry.key);
    if(await identity(file,'file')!==entry.identity)throw new LocalResetError(t("重置已停止：待删除文件发生变化，请重新确认。"));
    await fs.unlink(file);
    if(++count%128===0)await new Promise<void>(resolve=>setImmediate(resolve));
  }
  for(const entry of directories){
    await verifyParents(`${entry.key}/placeholder`);
    try{await fs.rmdir(path.join(plan.root,entry.key));}catch(error){if(!['ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }
  const remaining=await scanLocalReset(plan.root,protectedPaths);
  if(remaining.entries.some(entry=>entry.kind==='file')||remaining.rootIdentity.split(':').slice(0,2).join(':')!==plan.rootIdentity.split(':').slice(0,2).join(':'))throw new LocalResetError(t("重置期间本地附件范围发生变化，请重新确认剩余文件。"));
  return remaining;
}
/** Only the reset action may discard these plugin-generated state backups. */
export async function clearStateBackups(directory:string):Promise<void>{
  const pattern=/^data-v1\.[a-f0-9]{64}\.backup\.json(?:\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.staging)?$/;
  for(const name of await fs.readdir(directory)){
    if(!pattern.test(name))continue;
    const file=path.join(directory,name),metadata=await fs.lstat(file);
    if(!metadata.isFile())throw new Error('Unsafe state backup entry.');
    await fs.unlink(file);
  }
}
