// Recorded score deltas and an all-team capture walkthrough without new upstream calls.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const now=Date.parse('2026-11-17T19:00:00Z')/1000,seen=Date.parse('2026-11-16T20:00:00Z')/1000;
const teams=['BLUE','RED','GREEN','PURPLE','YELLOW','ORANGE','PINK'];
const before=teams.map(team=>({team,tiles:team==='RED'?5:10,explorer_points:20,checkin_points:0,total:(team==='RED'?5:10)+20}));
const current=before.map(row=>({...row}));
Object.assign(current[0],{tiles:12,explorer_points:25,total:37});
Object.assign(current[1],{tiles:4,total:24});
Object.assign(current[3],{tiles:11,explorer_points:30,total:41});
const score={available:true,stale:false,last_success:now,season_id:7,teams:current,history:[{at:Date.parse('2026-11-15T06:30:00Z')/1000,season_id:7,teams:before},{at:now,season_id:7,teams:current}]};
const cell=(cell_id,team,lon,lat,at)=>({cell_id,owner_team:team,west:lon,south:lat,east:lon+.002,north:lat+.002,captured_at:at,scores:{[team]:1}});
const coverage=[...Array.from({length:3},(_,i)=>cell('blue-'+i,'BLUE',-112+i*.002,41,now-7200)),...Array.from({length:2},(_,i)=>cell('purple-'+i,'PURPLE',-110+i*.002,39,now-10800)),cell('purple-far','PURPLE',-108,38,seen+3600),cell('before-visit','BLUE',-112,41,seen-3600),cell('old','ORANGE',-114,42,now-5*86400),cell('future','YELLOW',-114,42,now+3600)];
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:950},timezoneId:'America/Denver'});page.setDefaultTimeout(10000);
   await page.clock.install({time:new Date(now*1000)});
   await page.addInitScript(({width,seen,before})=>{
    if(width===390)Object.defineProperty(navigator,'standalone',{value:true});
    localStorage.setItem('meshwars-last-map-visit-v1',JSON.stringify({seen_at:seen,score:{at:seen-1800,season_id:7,teams:before}}));
   },{width,seen,before});
   const snapshot={available:true,coverage,coverage_count:coverage.length,revision:'debrief-fixture',source:'fixture',last_success:now,refresh_interval:1800,attribution:{configured:false},team_scores:score};
   const errors=[];page.on('pageerror',error=>errors.push(error.message));let boardReads=0,refreshes=0,detailRequests=0;
   page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/cells/'))detailRequests++;});
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
    if(['/api/board','/api/board/status'].includes(url.pathname)){boardReads++;return reply(snapshot);}
    if(url.pathname==='/api/board/refresh'){refreshes++;return reply({message:'Refresh requested.'});}
    if(url.pathname==='/api/version')return reply({version:'development',revision:null,changes:[]});
    if(url.pathname==='/api/players')return reply({available:false,players:[]});
    if(url.pathname==='/api/drives/status')return reply({configured:false});
    if(url.pathname==='/api/radio-coverage')return reply({available:false,configured:false,events:[]});
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(['index.html','app.js','search-client.js','startup.js','style.css'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
    return route.abort();
   });
   await page.goto('http://localhost:8000/');await page.locator('#app-loading').waitFor({state:'hidden'});
   assert.equal(await page.locator('#team-scoreboard #refresh-board').count(),1);
   assert.equal(await page.locator('#sidebar-data').isVisible(),false);
   await page.locator('#refresh-board').click();await page.waitForFunction(()=>document.getElementById('score-refresh-status').textContent.includes('Refresh requested'));
   assert.equal(refreshes,1);assert.equal(await page.locator('#refresh-board').isDisabled(),true);
   await page.clock.runFor(1600);await page.waitForFunction(()=>document.getElementById('score-refresh-status').textContent.startsWith('Checked'));
   assert.ok(boardReads>=2);await page.clock.runFor(14000);assert.equal(await page.locator('#refresh-board').isEnabled(),true);
   await page.evaluate(()=>{mapTeamFilter='GREEN';mapPlayerFilter='Nobody';capturedSquaresHidden=true;captureDays=7;$('capture-days').value='7';updateSquareDarkness(true);map.setView([0,0],4,{animate:false});});
   const filters=await page.evaluate(()=>({team:mapTeamFilter,player:mapPlayerFilter,hidden:capturedSquaresHidden,days:captureDays}));
   await page.locator('#open-debrief').click();
   assert.equal(await page.locator('#debrief-period').inputValue(),'visit');
   assert.equal(await page.locator('#debrief-team-list li').count(),7);
   const summary=await page.evaluate(()=>buildDebrief('visit'));
   assert.equal(summary.rows.find(r=>r.team==='BLUE').delta.total,7);
   assert.equal(summary.rows.find(r=>r.team==='PURPLE').delta.explorer_points,10);
   assert.equal(summary.rows.find(r=>r.team==='RED').delta.tiles,-1);
   assert.equal(summary.rows.reduce((n,r)=>n+r.cells.length,0),6,'Since last visit excludes earlier and future captures');
   assert.ok(summary.steps.some(s=>s.team==='RED'&&!s.bounds),'Score-only changes must be reviewed without inventing map locations');
   fs.mkdirSync(path.join(__dirname,'test-results'),{recursive:true});
   await page.screenshot({path:path.join(__dirname,`test-results/debrief-summary-${width}.png`)});
   await page.selectOption('#debrief-period','2');assert.equal(await page.evaluate(()=>debriefTour.summary.rows.reduce((n,r)=>n+r.cells.length,0)),7);
   await page.selectOption('#debrief-period','3');await page.selectOption('#debrief-period','visit');
   await page.locator('#debrief-start').click();
   const savedView=await page.evaluate(()=>({lat:debriefTour.view.center.lat,lng:debriefTour.view.center.lng}));
   assert.equal(await page.locator('#debrief-tour').isVisible(),true);
   assert.match(await page.locator('#debrief-tour-title').innerText(),/^PURPLE/);
   assert.ok(await page.evaluate(()=>debriefTour.layer.getLayers().length)>0);
   assert.deepEqual(await page.evaluate(()=>({team:mapTeamFilter,player:mapPlayerFilter,hidden:capturedSquaresHidden,days:captureDays})),filters,'Tour must leave ordinary map filters untouched');
   await page.clock.runFor(1000);
   await page.screenshot({path:path.join(__dirname,`test-results/debrief-tour-${width}.png`)});
   await page.locator('#debrief-next').click();await page.locator('#debrief-previous').click();
   assert.equal(await page.evaluate(()=>debriefTour.index),0);
   const steps=await page.evaluate(()=>debriefTour.steps.length);
   for(let i=1;i<steps;i++)await page.locator('#debrief-next').click();
   assert.match(await page.locator('#debrief-tour-captures').innerText(),/No matching capture area/);
   assert.equal(await page.evaluate(()=>debriefTour.layer.getLayers().length),0);
   await page.locator('#debrief-next').click();
   assert.equal(await page.locator('#debrief-tour').isVisible(),false);
   assert.ok(await page.evaluate(view=>map.getCenter().distanceTo(view),savedView)<1);
   assert.deepEqual(await page.evaluate(()=>({team:mapTeamFilter,player:mapPlayerFilter,hidden:capturedSquaresHidden,days:captureDays})),filters);
   const checks=await page.evaluate(()=>{
    const original=structuredClone(feedMetadata.team_scores),previous=previousDebriefVisit;
    previousDebriefVisit=null;feedMetadata.team_scores.history=[];
    const missing=buildDebrief('3');
    feedMetadata.team_scores.history=[{at:Date.now()/1000-3600,season_id:7,teams:original.teams},original.history.at(-1)];
    const partial=buildDebrief('3');
    feedMetadata.team_scores.history=[{...original.history[0],season_id:6},original.history.at(-1)];
    const season=buildDebrief('3');
    feedMetadata.team_scores=original;previousDebriefVisit={...previous,seen_at:Date.now()/1000-6*86400};
    const capped=buildDebrief('visit');previousDebriefVisit=previous;
    return {unknown:missing.rows.every(r=>r.delta===null),partial:partial.note,seasonUnknown:season.rows.every(r=>r.delta===null),capped:capped.note};
   });
   assert.equal(checks.unknown,true);assert.match(checks.partial,/Partial score history/);assert.equal(checks.seasonUnknown,true);assert.match(checks.capped,/limited to 3 calendar days/);
   assert.equal(detailRequests,0,'Debrief must use cached board data without cell-by-cell API scans');
   assert.deepEqual(errors,[]);
   await page.close();console.log(`Passed debrief ${width}px: score deltas, last visit, 1–3 days, all-team areas, score-only steps, history gaps, season isolation, end/restore and scoreboard refresh.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
