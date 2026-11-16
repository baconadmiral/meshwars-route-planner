// Native GPX sharing must be a direct tap, preserve full tracks and avoid downloads.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/handoff-preview.json'),'utf8'));
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const mode of ['native','xml','unsupported','cancel','fail','export-fail']){
   const page=await browser.newPage({viewport:{width:390,height:900}});page.setDefaultTimeout(10000);
   await page.addInitScript(mode=>{
    Object.defineProperty(navigator,'standalone',{value:true});
    window.fileShares=[];
    Object.defineProperty(navigator,'canShare',{value:data=>mode!=='unsupported'&&data.files?.length===1&&(mode!=='xml'||data.files[0].type==='application/xml')});
    Object.defineProperty(navigator,'share',{value:async data=>{
     const active=navigator.userActivation.isActive;
     if(mode==='cancel')throw new DOMException('Cancelled','AbortError');
     if(mode==='fail')throw new DOMException('Sharing failed','DataError');
     window.fileShares.push({active,title:data.title,name:data.files[0].name,type:data.files[0].type,text:await data.files[0].text()});
    }});
   },mode);
   const errors=[];page.on('pageerror',error=>errors.push(error.message));let exportRequests=0,downloads=0;
   page.on('download',()=>downloads++);
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
    if(url.pathname==='/api/route-export'){
     exportRequests++;if(mode==='export-fail'&&exportRequests===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary export failure'})});
     const body=route.request().postDataJSON();
     const coords=body.route.geometry.coordinates;
     const gpx='<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>'+coords.map(([lon,lat])=>`<trkpt lat="${lat}" lon="${lon}"/>`).join('')+'</trkseg></trk></gpx>';
     return reply({...fixture.export,gpx});
    }
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(['index.html','app.js','search-client.js','startup.js','style.css'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
    return route.abort();
   });
   await page.goto('http://localhost:8000/');await page.locator('#app-loading').waitFor({state:'hidden'});
   await page.evaluate(route=>{
    result={team:'BLUE',strategy:'beam',routes:[structuredClone(route)],baseline:structuredClone(route)};
    setPlanVisibility(true);showRoute(0);
   },fixture.route);
   await page.locator('#osmand-send:not([disabled])').waitFor();
   assert.equal(exportRequests,1);
   if(mode==='export-fail'){
    assert.equal(await page.locator('#osmand-send').innerText(),'Retry GPX preparation');
    assert.match(await page.locator('#osmand-send-status').innerText(),/Temporary export failure/);
    await page.locator('#osmand-send').click();await page.locator('#osmand-send:not([disabled])').waitFor();
    assert.equal(await page.locator('#osmand-send').innerText(),'Send to OsmAnd');
   }

   assert.equal(await page.locator('#route-pane').evaluate(el=>getComputedStyle(el).overflowY),'visible');
   assert.ok((await page.locator('#route-pane').boundingBox()).height>600,'Completed mobile routes need a full-height section');
   if(mode==='unsupported'){
    assert.equal(await page.locator('#osmand-send').innerText(),'Download GPX for OsmAnd');
    const download=page.waitForEvent('download');await page.locator('#osmand-send').click();await download;
    assert.equal(downloads,1);assert.equal(await page.evaluate(()=>fileShares.length),0);
   }else{
    await page.locator('#osmand-send').click();
    if(mode==='cancel'){
     await page.waitForFunction(()=>document.getElementById('osmand-send-status').textContent.includes('Sharing cancelled'));
     assert.equal(downloads,0);
    }else if(mode==='fail'){
     await page.waitForFunction(()=>document.getElementById('osmand-send-status').textContent.includes('File sharing could not start'));
     assert.equal(downloads,0);
    }else{
     await page.waitForFunction(()=>fileShares.length===1);
     const shared=await page.evaluate(()=>fileShares[0]);
     assert.equal(shared.active,true,'The native share must run in the tap, without awaiting a fetch');
     assert.equal((shared.text.match(/<trkpt /g)||[]).length,fixture.route.geometry.coordinates.length);
     assert.ok(shared.name.endsWith('.gpx'));assert.equal(downloads,0);
     if(mode==='xml')assert.equal(shared.type,'application/xml');
    }
   }
   await page.locator('#phone-navigation').click();await page.locator('#gpx-send-osmand').waitFor();
   assert.equal(exportRequests,mode==='export-fail'?2:1,'Opening the dialog must reuse the prepared export');
   assert.equal(await page.locator('#gpx-send-osmand').isVisible(),true,'OsmAnd action must be available before the QR tab');
   if(mode==='native'){
    await page.locator('#gpx-send-osmand').click();await page.waitForFunction(()=>fileShares.length===2);
    assert.equal(downloads,0);
    fs.mkdirSync(path.join(__dirname,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(__dirname,'test-results/mobile-osmand-handoff.png')});
   }
   await page.locator('#navigation-close').click();
   if(mode==='native'){
    await page.evaluate(()=>{const other=structuredClone(result.routes[0]);other.geometry.coordinates[0][0]+=.00001;result.routes.push(other);showRoute(1);});
    await page.locator('#osmand-send:not([disabled])').waitFor();await page.locator('#osmand-send').click();await page.waitForFunction(()=>fileShares.length===3);
    const texts=await page.evaluate(()=>fileShares.map(s=>s.text));assert.notEqual(texts[0],texts[2],'Sharing another route must not reuse the previous GPX');
    assert.equal(exportRequests,2);
   }
   assert.deepEqual(errors,[]);await page.close();console.log(`Passed OsmAnd ${mode}: direct file handoff/fallback, activation, full GPX, cache and expanded mobile results.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
