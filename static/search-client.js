'use strict';
// A tab keeps only the lookup token and request context, never cached route results.
window.RouteSearch=(()=>{
 const storageKey='meshwars-pending-search-v1';
 const cancellationKey='meshwars-search-cancellations-v1';
 const validToken=token=>typeof token==='string'&&/^[0-9a-f]{64}$/.test(token);
 let memory=null;
 let cancellations=new Set();
 try{cancellations=new Set(JSON.parse(sessionStorage.getItem(cancellationKey)||'[]').filter(validToken));}catch{}
 function saveCancellations(){try{sessionStorage.setItem(cancellationKey,JSON.stringify([...cancellations].slice(-16)));}catch{}}
 function pending(){
  try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(saved&&validToken(saved.token)&&saved.payload&&saved.context)memory=saved;}catch{}
  return memory;
 }
 function save(record){memory=record;try{sessionStorage.setItem(storageKey,JSON.stringify(record));}catch{}}
 function clear(token){if(memory?.token!==token)return;memory=null;try{sessionStorage.removeItem(storageKey);}catch{}}
 const abortError=()=>new DOMException('Search cancelled.','AbortError');
 const ready=()=>document.visibilityState!=='hidden'&&navigator.onLine!==false;
 function wait(signal,milliseconds=1500){
  return new Promise((resolve,reject)=>{
   let timer;
   const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);document.removeEventListener('visibilitychange',wake);window.removeEventListener('online',wake);window.removeEventListener('pageshow',wake);};
   const abort=()=>{cleanup();reject(abortError());};
   const wake=()=>{if(ready()){cleanup();resolve();}};
   signal.addEventListener('abort',abort,{once:true});
   document.addEventListener('visibilitychange',wake);window.addEventListener('online',wake);window.addEventListener('pageshow',wake);
   if(signal.aborted){abort();return;}
   if(ready())timer=setTimeout(()=>{cleanup();resolve();},milliseconds);
  });
 }
 async function request(path,method,body,signal){
  const controller=new AbortController();
  const abort=()=>controller.abort();
  const timer=setTimeout(abort,15000);
  signal.addEventListener('abort',abort,{once:true});
  // Discard stale requests both when suspending and when returning to the page.
  document.addEventListener('visibilitychange',abort);window.addEventListener('online',abort);window.addEventListener('pageshow',abort);
  try{
   if(signal.aborted)throw abortError();
   const response=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store',signal:controller.signal});
   const data=await response.json();
   if(!response.ok){const error=Error(data.error||'Route request failed.');error.status=response.status;throw error;}
   return data;
  }finally{
   clearTimeout(timer);signal.removeEventListener('abort',abort);document.removeEventListener('visibilitychange',abort);window.removeEventListener('online',abort);window.removeEventListener('pageshow',abort);
  }
 }
 async function cancelPending(record=pending()){
  if(record?.cancel_requested){cancellations.add(record.token);saveCancellations();}
  for(const token of [...cancellations]){
   try{
    const response=await fetch(`/api/searches/${token}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true,signal:AbortSignal.timeout(10000)});
    if(response.ok){cancellations.delete(token);saveCancellations();clear(token);}
   }catch{} // Keep the cancellation intent for the next connection or page load.
  }
 }
 window.addEventListener('online',()=>cancelPending());
 async function watch(record,onProgress,signal){
  let progress={percent:0,message:'Starting route search…'};
  const cancel=()=>{record.cancel_requested=true;save(record);void cancelPending(record);};
  signal.addEventListener('abort',cancel,{once:true});
  try{
   if(signal.aborted){cancel();throw abortError();}
   while(true){
    if(signal.aborted)throw abortError();
    if(!ready())await wait(signal);
    if(!record.submitted&&Date.now()-record.started_at>30*60*1000){clear(record.token);throw Error('This search request is too old. Please plan again.');}
    let data;
    try{
     data=await request(`/api/searches/${record.token}`,record.submitted?'GET':'POST',record.submitted?null:record.payload,signal);
     record.submitted=true;save(record);
    }catch(error){
     if(signal.aborted)throw abortError();
     if(error.status&&error.status<500&&error.status!==408&&!(record.submitted&&error.status===429)){clear(record.token);throw error;}
     onProgress({...progress,message:'Connection interrupted. Your search is retained; reconnecting…'});
     await wait(signal,3000);continue;
    }
    if(data.progress){progress=data.progress;onProgress(progress);}
    if(data.state==='complete'){clear(record.token);return data.result;}
    if(data.state==='error'||data.state==='cancelled'){
     clear(record.token);throw Error(data.error||'Search cancelled.');
    }
    await wait(signal);
   }
  }finally{signal.removeEventListener('abort',cancel);}
 }
 function start(payload,context,onProgress,signal){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const record={token:[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join(''),payload,context,started_at:Date.now(),submitted:false};
  save(record);return watch(record,onProgress,signal);
 }
 function resume(record,onProgress,signal){
  if(record.cancel_requested){void cancelPending(record);return Promise.reject(abortError());}
  save(record);return watch(record,onProgress,signal);
 }
 void cancelPending();
 return {start,resume,pending,cancelPending};
})();
