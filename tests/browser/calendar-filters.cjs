// Local calendar boundaries, DST, midnight refresh and legacy preference clamping.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const timezoneId of ['America/Denver','UTC']){
   const page=await browser.newPage({viewport:{width:390,height:900},timezoneId});page.setDefaultTimeout(10000);
   await page.clock.install({time:new Date('2026-11-02T19:00:00Z')});
   await page.addInitScript(()=>localStorage.setItem('blue-capture-days','60'));
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
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(['index.html','app.js','search-client.js','startup.js','style.css'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
    return route.abort();
   });
   await page.goto('http://localhost:8000/');await page.locator('#app-loading').waitFor({state:'hidden'});
   assert.equal(await page.locator('#capture-days').getAttribute('max'),'30');
   assert.equal(await page.locator('#capture-days').inputValue(),'30');
   await page.evaluate(()=>{
    const stamp=(day,hour=0)=>new Date(2026,10,day,hour).getTime()/1000;
    const now=Date.now()/1000;
    const values=[['today-start',stamp(2)],['today-noon',stamp(2,10)],['now',now],['yesterday-start',stamp(1)],['yesterday-late',stamp(2)-.001],['before-yesterday',stamp(1)-.001],['future',now+3600],['missing',null],['invalid','bad']];
    board=values.map(([cell_id,captured_at])=>({cell_id,captured_at,owner_team:'BLUE',west:0,south:0,east:.001,north:.001,scores:{BLUE:1}}));
    boardAvailable=true;feedMetadata.attribution={configured:true};squareLookupMoving=false;squareLookupMinZoom=13;
    map.setView([.0005,.0005],16,{animate:false});renderTeamScores();drawBoard();
   });
   await page.locator('#capture-days').fill('1');await page.waitForFunction(()=>document.getElementById('capture-days-value').value==='Today');
   assert.match(await page.locator('#capture-calendar-note').innerText(),new RegExp(timezoneId));
   assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),3);
   assert.match(await page.locator('#filtered-score-BLUE').innerText(),/3 territory pts · today/);
   assert.equal(await page.evaluate(()=>squareViewportCells().length),3);
   await page.locator('#capture-days').fill('2');await page.waitForFunction(()=>document.getElementById('capture-days-value').value==='Yesterday + today');
   assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),5);
   assert.equal(await page.evaluate(()=>squareViewportCells().length),5);
   assert.match(await page.locator('#filtered-score-BLUE').innerText(),/5 territory pts · yesterday \+ today/);
   const previousDayHours=await page.evaluate(()=>(new Date(2026,10,2)-new Date(2026,10,1))/3600000);
   assert.equal(previousDayHours,timezoneId==='America/Denver'?25:24);
   await page.evaluate(()=>{
    for(const date of [new Date(2026,2,9,12),new Date(2026,0,1,12)]){
     const expected=new Date(date);expected.setHours(0,0,0,0);expected.setDate(expected.getDate()-1);
     if(captureWindowStart(date.getTime()/1000)!==expected.getTime()/1000)throw Error('Calendar boundary failed across DST/year rollover');
    }
   });

   await page.locator('#find-capture-areas').click();
   assert.match(await page.locator('#capture-area-status').innerText(),/5 matching all-team squares/);
   await page.locator('#capture-days').fill('3');await page.waitForFunction(()=>document.getElementById('capture-days-value').value==='Last 3 days');
   assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),6);
   await page.locator('#capture-days').fill('0');await page.waitForFunction(()=>document.getElementById('capture-days-value').value==='All time');
   assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),9);
   await page.locator('#capture-days').fill('1');await page.waitForFunction(()=>document.getElementById('capture-days-value').value==='Today');
   const midnight=timezoneId==='America/Denver'?'2026-11-03T06:59:59Z':'2026-11-02T23:59:59Z';
   await page.clock.setSystemTime(new Date(midnight));
   await page.evaluate(()=>{
    const next=new Date();next.setHours(24,0,0,0);
    board.push({cell_id:'tomorrow',captured_at:next.getTime()/1000,owner_team:'BLUE',west:0,south:0,east:.001,north:.001,scores:{BLUE:1}});
    refreshCaptureCalendar();
   });
   await page.clock.runFor(1200);
   await page.waitForFunction(()=>document.getElementById('filtered-score-BLUE').textContent.startsWith('1 territory pts'));
   assert.deepEqual(await page.evaluate(()=>board.filter(c=>captureVisible(c)).map(c=>c.cell_id)),['tomorrow']);
   await page.evaluate(()=>{captureDays=2;updateSquareDarkness(true);});
   assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),5);
   assert.deepEqual(errors,[]);
   fs.mkdirSync(path.join(__dirname,'test-results'),{recursive:true});
   await page.screenshot({path:path.join(__dirname,`test-results/calendar-filter-${timezoneId.replace('/','-')}.png`)});
   await page.close();console.log(`Passed calendar captures in ${timezoneId}: today/yesterday boundaries, DST, counters, recon, 30-day clamp and automatic midnight rollover.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
