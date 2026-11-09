// Failed waypoint/roadblock searches must leave a visible, actionable error.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:844}});
   page.setDefaultTimeout(10000);
   let directConflict=true,searchRequests=0;
   const failure='No accessible road route found around your blocked sections within the bounded bypass checks. Required waypoints W1 must still be visited in order. Move the waypoint to an accessible road or adjust the blocked marks.';
   await page.addInitScript(()=>Object.defineProperty(navigator,'onLine',{get:()=>true}));
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    const reply=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    if(url.hostname==='tile.openstreetmap.org')return route.fulfill({contentType:'image/png',body:tile});
    if(url.hostname==='unpkg.com'){
     if(url.pathname.endsWith('leaflet.js'))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('leaflet/dist/leaflet-src.js'))});
     if(url.pathname.endsWith('leaflet.css'))return route.fulfill({contentType:'text/css',body:fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'))});
     if(url.pathname.endsWith('qrcode.js'))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('qrcode-generator'))});
     return route.fulfill({contentType:'image/png',body:tile});
    }
    if(['/api/board','/api/board/status'].includes(url.pathname))return reply({available:true,coverage:[],coverage_count:0,source:'fixture',revision:'1',attribution:{configured:false}});
    if(url.pathname==='/api/version')return reply({version:'development',revision:null,changes:[]});
    if(url.pathname==='/api/players')return reply({available:false,players:[]});
    if(url.pathname==='/api/drives/status')return reply({configured:false});
    if(url.pathname==='/api/radio-coverage')return reply({available:false,configured:false,events:[]});
    if(url.pathname==='/api/validate-route-area')return directConflict?route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Waypoint W1 is on blocked road 1. Move the stop or adjust the blocked section.',blocked_stops:['W1']})}):reply({allowed_bounds:null});
    if(url.pathname.startsWith('/api/searches/')){searchRequests++;return reply({state:'error',error:failure});}
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(['index.html','app.js','search-client.js','startup.js','style.css'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
    return route.abort();
   });
   await page.goto('http://localhost:8000/');
   await page.locator('#app-loading').waitFor({state:'hidden'});
   await page.locator('#start').fill('0, -0.01');await page.locator('#end').fill('0, 0.01');
   await page.evaluate(()=>{addWaypoint();document.querySelector('#waypoints input').value='0, 0';blockedRoads=[{coordinates:[[0,-.001],[0,.001]],buffer_meters:20}];drawBlockedRoads();});
   await page.locator('#submit').click();
   await page.waitForFunction(()=>!searching);
   assert.equal(searchRequests,0,'A stop on a blocked road must fail before creating a search');
   assert.match(await page.locator('#route-input-error').innerText(),/Waypoint W1 is on blocked road 1/);
   assert.equal(await page.locator('#waypoints input').getAttribute('aria-invalid'),'true');
   assert.equal(await page.locator('#waypoints input').evaluate(el=>el===document.activeElement),true);
   directConflict=false;
   await page.locator('#waypoints input').fill('0, -0.005');
   await page.locator('#submit').click();
   await page.waitForFunction(()=>!searching);
   assert.ok(searchRequests>0);
   assert.equal(await page.locator('#search-dialog').getAttribute('open'),null);
   assert.equal(await page.locator('#route-input-error').innerText(),failure);
   assert.equal(await page.locator('#route-input-error').evaluate(el=>el===document.activeElement),true);
   await page.waitForFunction(()=>{const box=document.getElementById('route-input-error').getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;});
   const box=await page.locator('#route-input-error').boundingBox();
   assert.ok(box.y>=0&&box.y+box.height<=844,'Failure must be in the visible viewport after the modal closes');
   assert.equal(await page.locator('#submit').isEnabled(),true);
   assert.equal(await page.locator('#waypoints input').inputValue(),'0, -0.005');
   assert.equal(await page.evaluate(()=>blockedRoads.length),1);
   assert.deepEqual(errors,[]);
   fs.mkdirSync(path.join(__dirname,'test-results'),{recursive:true});
   await page.screenshot({path:path.join(__dirname,`test-results/blocked-waypoint-error-${width}.png`)});
   await page.close();console.log(`Passed blocked waypoint failures at ${width}px: preflight identity, persistent visible late error, preserved settings and retry.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
