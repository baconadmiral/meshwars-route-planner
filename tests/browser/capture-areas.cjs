// Locate captured-square concentrations without querying individual square details.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<800});page.setDefaultTimeout(10000);
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   let detailRequests=0;page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/cells/'))detailRequests++;});
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
   await page.evaluate(()=>{
    const now=Date.now()/1000;
    const cell=(id,lon,lat,team='PURPLE',days=1,player='First')=>({cell_id:id,west:lon,south:lat,east:lon+.002,north:lat+.002,owner_team:team,captured_at:now-days*86400,captured_by:player,scores:{[team]:1}});
    board=[...Array.from({length:4},(_,i)=>cell('dense-'+i,-112+i*.002,41)),...Array.from({length:2},(_,i)=>cell('small-'+i,-110+i*.002,39)),cell('old',-114,42,'PURPLE',7),cell('missing',-112,41),cell('future',-112,41,'PURPLE',-1),...Array.from({length:8},(_,i)=>cell('blue-'+i,-100+i*.002,35,'BLUE'))];
    board.find(c=>c.cell_id==='missing').captured_at=null;
    boardAvailable=true;renderTeamScores();drawBoard();map.setView([0,0],5);
   });
   const planningTeam=await page.locator('#team').inputValue();
   await page.locator('[data-team="PURPLE"] button.team-score-filter').click();
   await page.locator('#capture-days').fill('5');
   await page.locator('#find-capture-areas').click();
   assert.match(await page.locator('#capture-area-status').innerText(),/Area 1 of 2 · 4 matching PURPLE squares/);
   assert.ok(await page.evaluate(()=>map.getBounds().contains([41.001,-111.996])),'Must locate captures beyond the starting viewport');
   assert.equal(await page.locator('#team').inputValue(),planningTeam,'Map filtering must not change the planning team');
   assert.equal(await page.locator('#next-capture-area').isEnabled(),true);
   await page.locator('#next-capture-area').click();
   assert.match(await page.locator('#capture-area-status').innerText(),/Area 2 of 2 · 2 matching PURPLE squares/);
   assert.ok(await page.evaluate(()=>map.getBounds().contains([39.001,-109.998])));
   await page.locator('#next-capture-area').click();
   assert.match(await page.locator('#capture-area-status').innerText(),/Area 1 of 2/);
   fs.mkdirSync(path.join(__dirname,'test-results'),{recursive:true});
   await page.screenshot({path:path.join(__dirname,`test-results/capture-areas-${width}.png`)});
   await page.locator('#all-capture-matches').click();
   assert.match(await page.locator('#capture-area-status').innerText(),/Showing all 6 matching squares/);
   assert.ok(await page.evaluate(()=>map.getBounds().contains([41.001,-111.996])&&map.getBounds().contains([39.001,-109.998])));
   await page.locator('#capture-days').fill('1');
   await page.evaluate(()=>{mapPlayerFilter='Nobody';drawBoard();});
   assert.equal(await page.locator('#next-capture-area').isEnabled(),false);
   await page.evaluate(()=>{window.emptyFitCalls=0;const fit=map.fitBounds;map.fitBounds=function(...args){window.emptyFitCalls++;return fit.apply(this,args);};});
   assert.equal(await page.locator('#find-capture-areas').isDisabled(),true);
   assert.match(await page.locator('#capture-area-status').innerText(),/No matching territory squares/);
   assert.equal(await page.evaluate(()=>window.emptyFitCalls),0,'Empty results must not request a map fit');
   await page.evaluate(()=>{mapPlayerFilter='';capturedSquaresHidden=true;drawBoard();});
   assert.equal(await page.locator('#find-capture-areas').isDisabled(),true);
   assert.match(await page.locator('#capture-area-status').innerText(),/Show captured squares first/);
   await page.evaluate(()=>{capturedSquaresHidden=false;captureDays=5;$('capture-days').value='5';mapPlayerFilter='';updateSquareDarkness(true);setTeamMapFilter('GREEN');});
   assert.match(await page.locator('#filtered-score-GREEN').innerText(),/^0 territory pts/);
   assert.equal(await page.locator('#find-capture-areas').isDisabled(),true,'Zero filtered territory must disable Recon sweep');
   await page.evaluate(()=>setTeamMapFilter('PURPLE'));
   assert.equal(await page.locator('#find-capture-areas').isEnabled(),true,'Matching captures must re-enable Recon sweep');
   await page.locator('#find-capture-areas').click();
   assert.match(await page.locator('#capture-area-status').innerText(),/4 matching PURPLE squares/);
   await page.evaluate(()=>setTeamMapFilter('GREEN'));
   await page.locator('#find-capture-areas').scrollIntoViewIfNeeded();
   await page.screenshot({path:path.join(__dirname,`test-results/empty-recon-${width}.png`)});
   await page.evaluate(()=>{
    const c=(id,lon,lat)=>({cell_id:id,west:lon,east:lon+.001,south:lat,north:lat+.001,captured_at:1});
    const groups=rankCaptureAreas([c('a',179.99,0),c('b',-179.99,0),c('other',0,50)]);
    if(groups.length!==2||groups[0].count!==2||groups[0].bounds[1][1]-groups[0].bounds[0][1]>.1)throw Error('Date-line proximity/bounds failed');
    if(rankCaptureAreas([]).length!==0)throw Error('Empty clustering failed');
    if(rankCaptureAreas([c('invalid',NaN,0)]).length!==0)throw Error('Invalid bounds accepted');
   });
   assert.equal(detailRequests,0,'Capture finder must not trigger individual square API requests');assert.deepEqual(errors,[]);
   await page.close();console.log(`Passed capture areas at ${width}px: ranked global groups, team/date filters, next/wrap, all matches, invalidation, empty/hidden states and date line.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
