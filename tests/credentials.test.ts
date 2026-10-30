import { expect, it, vi } from 'vitest';
import { saveR2Credentials } from '../src/obsidian/credentials';
import { StateStore, settingsState } from '../src/core/state';
import { cloudFailureMessage } from '../src/core/r2';

function setup(persist:(value:unknown)=>Promise<void>=async()=>{}){
  const initial=settingsState(null);initial.settings.accessKeySecret='old-access';initial.settings.secretKeySecret='old-secret';
  const state=new StateStore(initial,persist),entries=new Map([['old-access','previous-id'],['old-secret','previous-key']]);
  const storage={setSecret:vi.fn((name:string,value:string)=>{entries.set(name,value);})};
  return{state,entries,storage};
}
it('publishes fresh paired references only after both secret writes and preserves existing entries',async()=>{
  const saved:unknown[]=[],x=setup(async value=>{saved.push(value);});
  await saveR2Credentials(x.state,x.storage,'  placeholder-id\n',' placeholder-key ');
  const settings=x.state.snapshot().settings;
  expect(settings.accessKeySecret).toMatch(/^pictether-r2-[a-f0-9-]{36}-id$/);
  expect(settings.secretKeySecret).toBe(settings.accessKeySecret.replace(/-id$/,'-key'));
  for(const name of [settings.accessKeySecret,settings.secretKeySecret])expect(name.length).toBeLessThanOrEqual(64);
  expect(x.entries.get(settings.accessKeySecret)).toBe('placeholder-id');expect(x.entries.get(settings.secretKeySecret)).toBe('placeholder-key');
  expect(x.entries.get('old-access')).toBe('previous-id');expect(x.entries.get('old-secret')).toBe('previous-key');
  expect(saved).toHaveLength(1);expect(JSON.stringify(saved)).not.toContain('placeholder-id');expect(JSON.stringify(saved)).not.toContain('placeholder-key');
  const first=settings.accessKeySecret;
  await saveR2Credentials(x.state,x.storage,'replacement-id','replacement-key');
  expect(x.state.snapshot().settings.accessKeySecret).not.toBe(first);expect(x.entries.get(first)).toBe('placeholder-id');
});
it('keeps the old pair when the second secret write fails and never echoes storage error contents',async()=>{
  const persist=vi.fn(async()=>{}),x=setup(persist);let writes=0;
  x.storage.setSecret.mockImplementation((name,value)=>{if(++writes===2)throw new Error(`sensitive-marker ${value}`);x.entries.set(name,value);});
  let failure:unknown;try{await saveR2Credentials(x.state,x.storage,'placeholder-id','placeholder-key');}catch(error){failure=error;}
  expect(cloudFailureMessage(failure)).toContain('原配置已保留');expect(cloudFailureMessage(failure)).not.toContain('sensitive-marker');
  expect(cloudFailureMessage(failure)).not.toContain('placeholder-key');expect(persist).not.toHaveBeenCalled();
  expect(x.state.snapshot().settings).toMatchObject({accessKeySecret:'old-access',secretKeySecret:'old-secret'});
  expect(x.entries.get('old-access')).toBe('previous-id');expect(x.entries.get('old-secret')).toBe('previous-key');
});
it('preserves the old published references when settings persistence fails',async()=>{
  const x=setup(async()=>{throw new Error('sensitive-marker');});
  await expect(saveR2Credentials(x.state,x.storage,'placeholder-id','placeholder-key')).rejects.toThrow('原配置已保留');
  expect(x.state.snapshot().settings).toMatchObject({accessKeySecret:'old-access',secretKeySecret:'old-secret'});
  expect(x.entries.size).toBe(4);
});
it.each([['','key'],['id',''],['same','same'],[' ','key']])('rejects an incomplete or identical pair without touching storage',async(id,key)=>{
  const x=setup();await expect(saveR2Credentials(x.state,x.storage,id,key)).rejects.toThrow();expect(x.storage.setSecret).not.toHaveBeenCalled();
});
it('requires SecretStorage and does not use a plaintext fallback',async()=>{
  const x=setup();await expect(saveR2Credentials(x.state,undefined,'placeholder-id','placeholder-key')).rejects.toThrow('SecretStorage 不可用');
  expect(x.state.snapshot().settings).toMatchObject({accessKeySecret:'old-access',secretKeySecret:'old-secret'});
});
