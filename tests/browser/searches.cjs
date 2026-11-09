// Phone search lifecycle with real app/Leaflet and deterministic server jobs.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/handoff-preview.json'),'utf8'));
const blankTile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const result={team:'BLUE',strategy:'greedy',routes:[fixture.route],baseline:fixture.route,board_revision:'fixture'};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const jobs=new Map();let creations=0,posts=0,cancellations=0,dropCreation=true,cancelBlocked=false,holdNextPoll=false,onHeldPoll=null;
  await page.route('**/*',async intercepted=>{
   const url=new URL(intercepted.request().url()),method=intercepted.request().method();
   const reply=(data,status=200)=>intercepted.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
   if(url.hostname==='tile.openstreetmap.org')return intercepted.fulfill({contentType:'image/png',body:blankTile});
   if(url.hostname==='unpkg.com'){
    if(url.pathname.endsWith('leaflet.js'))return intercepted.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('leaflet/dist/leaflet-src.js'))});
    if(url.pathname.endsWith('leaflet.css'))return intercepted.fulfill({contentType:'text/css',body:fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'))});
    if(url.pathname.endsWith('qrcode.js'))return intercepted.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('qrcode-generator'))});
    return intercepted.abort();
   }
   if(['/api/board','/api/board/status'].includes(url.pathname))return reply({available:true,coverage:[],coverage_count:0,source:'fixture',revision:'fixture',attribution:{configured:false}});
   if(url.pathname==='/api/version')return reply({version:'development',revision:null});
   if(url.pathname==='/api/drives/status')return reply({configured:false});
   if(url.pathname==='/api/radio-coverage')return reply({available:false,configured:false,events:[]});
   if(url.pathname==='/api/players')return reply({available:false,players:[]});
   if(url.pathname.startsWith('/api/searches/')){
    const token=url.pathname.split('/')[3];
    if(url.pathname.endsWith('/cancel')){
     if(cancelBlocked)return intercepted.abort();
     cancellations++;jobs.set(token,{state:'cancelled',error:'Search cancelled.'});return reply(jobs.get(token));
    }
    if(method==='GET'&&holdNextPoll){holdNextPoll=false;onHeldPoll();return;}
    if(method==='POST'){
     posts++;
     if(!jobs.has(token)){creations++;jobs.set(token,{state:'running',progress:{percent:10,message:'Checking routes'}});}
     if(dropCreation){dropCreation=false;return intercepted.abort();}
    }
    return reply(jobs.has(token)?{token,...jobs.get(token)}:{error:'Search expired or the server restarted. Please plan again.'},jobs.has(token)?200:404);
   }
   const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
   if(['index.html','app.js','search-client.js','style.css'].includes(name))return intercepted.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
   return intercepted.abort();
  });
  await page.goto('http://localhost:8000/');
  await page.waitForFunction(()=>typeof map!=='undefined'&&map&&boardAvailable);
  await page.locator('#start').fill('0, 0');await page.locator('#end').fill('0.02, 0.02');
  await page.locator('#submit').click();
  await page.locator('#search-dialog[open]').waitFor();
  assert.equal(await page.locator('#search-dialog #search-progress').isVisible(),true);
  const output=path.join(__dirname,'test-results');fs.mkdirSync(output,{recursive:true});
  await page.screenshot({path:path.join(output,'mobile-search-progress.png')});
  await page.waitForFunction(()=>document.getElementById('progress-stage').textContent.includes('Connection interrupted'));
  const token=await page.evaluate(()=>RouteSearch.pending().token);
  assert.equal(creations,1);
  // Freeze after hiding, finish the server job, then wake the page.
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  const client=await page.context().newCDPSession(page);
  await client.send('Page.setWebLifecycleState',{state:'frozen'});
  jobs.set(token,{state:'complete',result,progress:{percent:100,message:'Complete'}});
  await client.send('Page.setWebLifecycleState',{state:'active'});
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>!searching&&result!==null);
  assert.equal(creations,1,'Lost create response must not produce a duplicate search');
  assert.ok(posts>=2,'Client should retry the same token after losing creation response');
  assert.equal(await page.locator('#search-dialog').getAttribute('open'),null);
  assert.equal(await page.locator('#search-progress').isVisible(),false);
  assert.equal(await page.evaluate(()=>routeLayer.getLayers().length>0),true);
  assert.equal(await page.evaluate(()=>document.getElementById('map').getBoundingClientRect().top<innerHeight/2),true,'Completed route should be brought into view');
  await page.screenshot({path:path.join(output,'mobile-search-complete.png')});
  // An OS tab reload restores the pending job and its original form context.
  await page.locator('#submit').click();
  await page.waitForFunction(()=>RouteSearch.pending()?.submitted===true);
  const second=await page.evaluate(()=>RouteSearch.pending().token),postsBeforeReload=posts;
  await page.reload();
  await page.locator('#search-dialog[open]').waitFor();
  assert.equal(await page.locator('#start').inputValue(),'0, 0');
  assert.equal(await page.locator('#end').inputValue(),'0.02, 0.02');
  assert.equal(posts,postsBeforeReload,'Reload should retrieve the existing job');
  // Return from sleep even if the previous polling connection never finishes.
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Expected a held progress request')),5000);
   onHeldPoll=()=>{clearTimeout(timer);resolve();};holdNextPoll=true;
  });
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  jobs.set(second,{state:'complete',result,progress:{percent:100,message:'Complete'}});
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>!searching&&result!==null);
  assert.equal(creations,2);
  // Cancel is explicit, removes the pending state and closes the phone overlay.
  await page.locator('#submit').click();
  await page.waitForFunction(()=>RouteSearch.pending()?.submitted===true);
  const cancelledToken=await page.evaluate(()=>RouteSearch.pending().token);
  cancelBlocked=true;
  await page.locator('#cancel-search').click();
  await page.waitForFunction(()=>!searching&&RouteSearch.pending()?.cancel_requested===true);
  assert.equal(await page.locator('#search-progress').isVisible(),false);
  assert.equal(await page.locator('#search-dialog').getAttribute('open'),null);
  assert.match(await page.locator('#status').textContent(),/Search cancelled/);
  // A new request must not erase an undelivered cancellation for the prior job.
  await page.locator('#submit').click();
  await page.waitForFunction(()=>RouteSearch.pending()?.submitted===true&&!RouteSearch.pending()?.cancel_requested);
  const replacementToken=await page.evaluate(()=>RouteSearch.pending().token);
  cancelBlocked=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('meshwars-search-cancellations-v1')).length===0);
  assert.equal(jobs.get(cancelledToken).state,'cancelled');
  assert.equal(await page.evaluate(()=>RouteSearch.pending().token),replacementToken);
  await page.locator('#cancel-search').click();
  await page.waitForFunction(()=>!searching&&RouteSearch.pending()===null);
  assert.equal(cancellations,2);
  // Desktop keeps its map control while running, then hides it on completion too.
  await page.setViewportSize({width:1280,height:1000});
  await page.locator('#submit').click();
  await page.waitForFunction(()=>RouteSearch.pending()?.submitted===true);
  assert.equal(await page.locator('#search-dialog').getAttribute('open'),null);
  assert.equal(await page.locator('#map #search-progress').isVisible(),true);
  const desktop=await page.evaluate(()=>RouteSearch.pending().token);
  jobs.set(desktop,{state:'complete',result,progress:{percent:100,message:'Complete'}});
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>!searching);
  assert.equal(await page.locator('#search-progress').isVisible(),false);
  assert.deepEqual(errors,[]);
  await page.close();
  console.log('Passed resumable searches: lost POST, hidden/frozen page, reload recovery, cancellation, mobile modal/route focus and desktop cleanup.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
