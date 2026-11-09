'use strict';
const CACHE_PREFIX='meshwars-offline-';
const CACHE_NAME=CACHE_PREFIX+'__BUILD_REVISION__';
const OFFLINE_URL='/offline.html';
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE_NAME);
  await cache.add(new Request(OFFLINE_URL,{cache:'reload'}));
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  for(const name of await caches.keys()){
   if(name.startsWith(CACHE_PREFIX)&&name!==CACHE_NAME)await caches.delete(name);
  }
  await self.clients.claim();
 })());
});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 // Never intercept APIs, POSTs, GPX downloads, assets, or external map providers.
 if(event.request.method!=='GET'||event.request.mode!=='navigate'||url.origin!==self.location.origin||!['/','/reports'].includes(url.pathname))return;
 event.respondWith((async()=>{
  try{return await fetch(event.request,{cache:'no-store'});}
  catch{
   const offline=await caches.match(OFFLINE_URL,{cacheName:CACHE_NAME});
   return offline||new Response('You are offline. Reconnect to use MeshWars Route Planner.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }
 })());
});
