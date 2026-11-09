// Real service-worker lifecycle on localhost, with no upstream providers.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const directory=path.resolve(__dirname,'../../static');
let revision='a'.repeat(40);
let networkAvailable=true;
const files={'/':'index.html','/reports':'reports.html','/style.css':'style.css','/reports.css':'reports.css','/pwa.js':'pwa.js','/sw.js':'sw.js','/offline.html':'offline.html','/manifest.webmanifest':'manifest.webmanifest','/icons/icon.svg':'icons/icon.svg','/icons/icon-192.png':'icons/icon-192.png','/icons/icon-512.png':'icons/icon-512.png','/icons/apple-touch-icon.png':'icons/apple-touch-icon.png'};
const server=http.createServer((request,response)=>{
 if(!networkAvailable){request.socket.destroy();return;}
 const url=new URL(request.url,'http://localhost');
 response.setHeader('Cache-Control','no-store');
 if(url.pathname.startsWith('/api/')){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({revision}));return;}
 // Omit the map/report apps: this test exercises the real install and SW scripts.
 if(['/app.js','/reports.js'].includes(url.pathname)){response.setHeader('Content-Type','application/javascript');response.end('');return;}
 const file=files[url.pathname];
 if(!file){response.writeHead(404);response.end();return;}
 response.setHeader('Content-Type',file.endsWith('.webmanifest')?'application/manifest+json':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/html');
 const content=fs.readFileSync(path.join(directory,file));
 response.end(file==='sw.js'?content.toString().replace('__BUILD_REVISION__',revision):content);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.route('https://unpkg.com/**',route=>route.abort());
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const manifest=await (await page.request.get(origin+'/manifest.webmanifest')).json();
  assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');
  for(const icon of manifest.icons){
   const dimensions=await page.evaluate(src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(`${image.naturalWidth}x${image.naturalHeight}`);image.onerror=reject;image.src=src;}),icon.src);
   assert.equal(dimensions,icon.sizes);
  }
  const client=await context.newCDPSession(page);
  const details=await client.send('Page.getAppManifest');
  assert.deepEqual(details.errors,[],'Browser must parse the manifest without errors');
  // Exercise the browser-controlled prompt UI without claiming a real OS install.
  await page.evaluate(()=>{
   const event=new Event('beforeinstallprompt',{cancelable:true});
   event.prompt=async()=>{window.installPromptUsed=true;};event.userChoice=Promise.resolve({outcome:'accepted'});
   window.dispatchEvent(event);
  });
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Visible install controls must fit a phone viewport');
  await page.locator('[data-install-app]').click();
  assert.equal(await page.evaluate(()=>window.installPromptUsed),true);
  assert.equal(await page.locator('[data-install-app]').isVisible(),false);
  // A deployed build changes the worker and removes its previous offline cache.
  await page.locator('#start').fill('Keep this unfinished trip');
  revision='b'.repeat(40);
  await page.evaluate(async()=>{
   const registration=await navigator.serviceWorker.getRegistration();
   registration.addEventListener('updatefound',()=>{
    const worker=registration.installing;
    worker.addEventListener('statechange',()=>{if(worker.state==='activated')window.updatedWorkerActive=true;});
   },{once:true});
   await registration.update();
  });
  await page.waitForFunction(()=>window.updatedWorkerActive===true,null,{timeout:5000});
  assert.equal(await page.locator('#start').inputValue(),'Keep this unfinished trip','Updating the worker must not reload or lose form input');
  await page.evaluate(()=>fetch('/api/version').then(response=>response.json()));
  const entries=await page.evaluate(async()=>{const result=[];for(const name of await caches.keys())for(const request of await (await caches.open(name)).keys())result.push({name,path:new URL(request.url).pathname});return result;});
  assert.deepEqual(entries,[{name:'meshwars-offline-'+'b'.repeat(40),path:'/offline.html'}],'Only the current build offline notice should be cached');
  networkAvailable=false;
  await context.setOffline(true);
  assert.equal(await page.evaluate(()=>fetch('/api/version').then(()=>false,()=>true)),true,'API must fail offline rather than returning cached data');
  await page.goto(origin+'/reports');
  assert.equal(await page.locator('h1').textContent(),'You’re offline.');
  await page.goto(origin+'/?offline-check');
  assert.equal(await page.locator('h1').textContent(),'You’re offline.');
  networkAvailable=true;
  await context.setOffline(false);
  await page.getByRole('link',{name:'Try planner again',exact:true}).click();
  await page.locator('#start').waitFor();
  assert.equal(await page.locator('#app-version').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Install controls must fit a phone viewport');
  assert.deepEqual(errors,[]);
  await context.close();
  console.log('Passed PWA: manifest/icons, install prompt, build updates, offline fallback, network-only APIs, reconnect and mobile header.');
 }finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));
 }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
