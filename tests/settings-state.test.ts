import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, credentialFingerprint, selectCredential, settingsState } from '../src/core/state';

it('converts a legacy pair to one untested profile using references only',()=>{
  const {credentials:_,activeCredential:__,...legacy}=DEFAULT_SETTINGS;
  const result=settingsState({version:2,settings:{...legacy,accessKeySecret:'existing-id-reference',secretKeySecret:'existing-key-reference'}});
  expect(result.settings.credentials).toEqual([{id:'legacy-default',name:'默认凭据',accessKeySecret:'existing-id-reference',secretKeySecret:'existing-key-reference'}]);
  expect(result.settings.activeCredential).toBe('legacy-default');
  expect(settingsState(result)).toEqual(result);
});
it('allows no current credential without silently activating another profile',()=>{
  const state=settingsState(null).settings;
  state.credentials=[{id:'one',name:'one',accessKeySecret:'id-ref',secretKeySecret:'key-ref'}];
  selectCredential(state,'one');expect(state.accessKeySecret).toBe('id-ref');
  selectCredential(state,'');expect(state.accessKeySecret).toBe('');expect(state.credentials).toHaveLength(1);
  expect(()=>selectCredential(state,'missing')).toThrow();
});
it('binds saved connection status to endpoint, bucket, region and both references',()=>{
  const state=settingsState(null).settings,profile={accessKeySecret:'id-ref',secretKeySecret:'key-ref'};
  const fingerprint=credentialFingerprint(state,profile);
  for(const patch of [{endpoint:'https://changed.example'},{bucket:'new-bucket'},{region:'new-region'}])expect(credentialFingerprint({...state,...patch},profile)).not.toBe(fingerprint);
  expect(credentialFingerprint(state,{...profile,secretKeySecret:'new-ref'})).not.toBe(fingerprint);
});
it('rejects malformed list and stored test data',()=>{
  for(const credentials of [null,{},[{id:'one',name:'one',accessKeySecret:'id-ref',secretKeySecret:'key-ref',test:{status:'ok',checkedAt:0,fingerprint:'not-a-hash'}}]]){
    expect(()=>settingsState({version:2,settings:{...DEFAULT_SETTINGS,credentials}})).toThrow();
  }
});
