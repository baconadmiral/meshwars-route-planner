// Real Leaflet/QR rendering with deterministic APIs and tiles; no live services.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/handoff-preview.json'),'utf8'));
const blankTile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const box={west:-.01,south:-.01,east:.03,north:.03};
const polygon={type:'Polygon',coordinates:[[[-.01,-.01],[.03,-.01],[.03,.03],[0,.03],[-.01,.02],[-.01,-.01]]]};

(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const scenario of [{name:'no-area',area:null},{name:'box',area:box},
      {name:'polygon',area:polygon},{name:'place-bonus',area:box,bonus:true},{name:'mobile-polygon',area:polygon,mobile:true},
      {name:'preview-unavailable',area:box,failPreview:true}]){
   const page=await browser.newPage({viewport:scenario.mobile?{width:390,height:844}:{width:1280,height:1000}});
   page.setDefaultTimeout(5000);
   await page.emulateMedia({colorScheme:'dark'});
   const errors=[];let squareDetailRequests=0;let planRequests=0,driveReportFails=false,holdSquareRequest=false,releaseSquareRequest=null,failSquareRequest=false;
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',async intercepted=>{
    const url=new URL(intercepted.request().url());
    const reply=data=>intercepted.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    if(url.hostname==='tile.openstreetmap.org')return intercepted.fulfill({contentType:'image/png',body:blankTile});
    if(url.hostname==='unpkg.com'){
     if(url.pathname.endsWith('leaflet.js'))return intercepted.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('leaflet/dist/leaflet-src.js'))});
     if(url.pathname.endsWith('leaflet.css'))return intercepted.fulfill({contentType:'text/css',body:fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'))});
     if(url.pathname.endsWith('qrcode.js'))return intercepted.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('qrcode-generator'))});
     if(url.pathname.endsWith('.png'))return intercepted.fulfill({contentType:'image/png',body:blankTile});
    }
    if(url.pathname==='/api/board'||url.pathname==='/api/board/status')return reply({available:true,coverage:[],coverage_count:0,source:'fixture',revision:'1',refresh_interval:1800,attribution:{configured:false}});
    if(url.pathname.startsWith('/api/cells/'))squareDetailRequests++;
    if(url.pathname==='/api/cells/0_3')return reply({cell_id:'0_3',owner_team:'RED',captured_at:300,captured_by:'Automatic player',scores:{RED:1},checked_at:Date.now()/1000,capture_event:{cell_id:'0_3',ts:300,team:'RED',player:'Automatic player'}});
    if(url.pathname==='/api/cells/0_2'){
     if(holdSquareRequest)await new Promise(resolve=>{releaseSquareRequest=resolve;});
     if(failSquareRequest)return intercepted.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Test square lookup failure'})});
     return reply({cell_id:'0_2',owner_team:'BLUE',captured_at:200,captured_by:'Older player',scores:{BLUE:2},checked_at:Date.now()/1000,capture_event:{cell_id:'0_2',ts:200,team:'BLUE',player:'Older player'}});
    }
    if(url.pathname.startsWith('/api/cells/'))return reply({cell_id:url.pathname.split('/').at(-1),owner_team:'BLUE',captured_at:null,captured_by:null,capture_event:null,checked_at:Date.now()/1000});
    if(url.pathname==='/api/players')return reply({available:true,configured:true,players:[{name:'🥓',team:'BLUE'},{name:'Other <player>',team:'RED'}]});
    if(url.pathname==='/api/drives/status')return reply({configured:true,player:'🥓',node:'!0123abcd'});
    if(url.pathname==='/api/drives/start')return reply({player:'🥓',node:'!0123abcd',team:'BLUE',started_at:Date.now()/1000-60,ended_at:null,board:'meshtastic'});
    if(url.pathname==='/api/drives/report'){
     if(driveReportFails)return intercepted.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Temporary upstream failure'})});
     const body=intercepted.request().postDataJSON();assert.equal(body.report,undefined);
     return reply({...body,checked_at:Date.now()/1000,unique_squares:2,capture_events:3,enemy_capture_events:1,unclaimed_capture_events:2,feed_limit_reached:true,events:[{cell_id:'0_0',ts:Date.now()/1000-30,team:'BLUE',from_team:'RED'}],notice:'Player attribution across all radios.'});
    }
    if(url.pathname==='/api/radio-coverage')return reply({events:[],configured:false,available:false});
    if(url.pathname==='/api/validate-route-area')return intercepted.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Start (A), Waypoint W1, Destination (B) must be inside the route area.',outside_stops:['start','W1','end']})});
    if(url.pathname==='/api/plan-stream'){planRequests++;return intercepted.abort();}
    if(url.pathname==='/api/route-export')return reply(fixture.export);
    if(url.pathname==='/api/gpx-shares')return reply({download_path:'/api/gpx-shares/test.gpx',expires_at:Date.now()/1000+3600});
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(['index.html','app.js','style.css'].includes(name))return intercepted.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
    return intercepted.abort();
   });
   await page.goto('http://localhost:8000/');
   await page.waitForFunction(()=>typeof map!=='undefined'&&map&&typeof radioLayer!=='undefined'&&radioLayer);
   assert.equal(await page.locator('#team').isVisible(),true);
   assert.equal(await page.locator('#saved-trip').isVisible(),true);
   assert.equal(await page.locator('#start').isVisible(),true);
   assert.equal(await page.locator('#end').isVisible(),true);
   assert.equal(await page.locator('#budget').isVisible(),true);
   assert.equal(await page.locator('#capture-days').isVisible(),true);
   assert.equal(await page.locator('#drive-player').isVisible(),false);
   assert.equal(await page.locator('#player-filter').isVisible(),false);
   assert.equal(await page.locator('#strategy').isVisible(),false);
   if(scenario.name==='no-area'){
    const sidebarOutput=path.join(__dirname,'test-results');fs.mkdirSync(sidebarOutput,{recursive:true});
    await page.screenshot({path:path.join(sidebarOutput,'sidebar-planning.png')});
    await page.locator('[data-sidebar-target="sidebar-map"]').click();
    assert.equal(await page.locator('#player-filter').isVisible(),true);
    await page.locator('[data-sidebar-target="sidebar-plan"]').click();
    console.log('Passed sidebar layout: primary planning controls visible, secondary tools collapsed, shortcuts open sections.');
   }

   await page.evaluate(({route,area,failPreview,bonus})=>{
    result={routes:[route],baseline:route,team:'BLUE',strategy:'beam',allowed_bounds:area};
    if(bonus){
     const place={id:42,name:'Test landmark',type:'landmark',lat:.001,lon:.01,points:25,rotates:true};
     result.places={enabled:true,available:true,remaining:100,weight:1,week_start:'2026-11-04',places:[place],excluded:[]};
     route.place_bonus=25;route.place_count=1;route.bonus_places=[place];route.capture_value=33;
    }
    route.territory_value=8;route.territory_breakdown={easy_enemy:3,defended_enemy:0,unknown_enemy:0,unpainted:5};
    tripLabels={start:'A',end:'B',waypoints:[]};
    showActiveResult();
    if(failPreview)drawHandoffPreview=()=>{throw Error('Simulated preview failure');};
   },{route:fixture.route,area:scenario.area,failPreview:scenario.failPreview,bonus:scenario.bonus});
   assert.match(await page.locator('.route-value').innerText(),/territory priority/);
   assert.equal(await page.locator('.route-value tbody tr').count(),4);
   assert.equal(await page.evaluate(()=>Object.keys(colors).every(team=>routeColor(team)!==colors[team])),true);
   assert.equal(await page.evaluate(()=>routeLayer.getLayers().at(-1).getLayers()[0].options.color),await page.evaluate(()=>routeColor(result.team)));
   await page.waitForFunction(()=>boardAvailable);
   assert.equal(await page.locator('.team-score').count(),7);
   if(scenario.name==='no-area'){
    await page.evaluate(()=>{
     board=['BLUE','RED','BLUE','RED','GREEN','UNRECOGNIZED'].map((team,i)=>({
      owner_team:team,cell_id:`0_${i}`,west:i*.00384,east:(i+1)*.00384,south:0,north:.0027,scores:{[team]:1}}));
     board[0].captured_by='🥓';board[1].captured_by='Other <player>';
     feedMetadata.attribution={configured:true,partial:true};renderPlayerFilter();
     feedMetadata.stale=true;
     feedMetadata.team_scores={available:true,stale:true,last_success:1,teams:Object.keys(colors).map(team=>({
      team,tiles:team==='BLUE'||team==='RED'?2:team==='GREEN'?1:0,
      total:team==='BLUE'?100:team==='RED'?500:team==='GREEN'?250:0,checkin_points:10,explorer_points:20}))};
     renderTeamScores();
    });
    await page.selectOption('#player-filter','🥓');
    assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),1);
    await page.evaluate(()=>setTeamMapFilter('RED'));
    assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),0);
    await page.evaluate(()=>setTeamMapFilter('RED'));
    await page.selectOption('#player-filter','__unknown__');
    assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),4);
    await page.selectOption('#player-filter','Other <player>');
    assert.equal(await page.evaluate(()=>territories.getLayers()[0]?.getTooltip()?.getContent().includes('Other &lt;player&gt;')),true);
    await page.selectOption('#player-filter','');
    assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),6);
    assert.equal(await page.evaluate(()=>result.routes[0].capture_value),8);
    console.log('Passed player filter: Unicode roster, unknown names, escaped tooltips, team intersection, unchanged route value.');
    holdSquareRequest=true;
    await page.evaluate(()=>{board[2].captured_at=200;territories.getLayers()[2].fire('click');});
    await page.locator('.square-refresh-outline').waitFor();
    assert.equal(await page.locator('.square-refresh-label').innerText(),'Refreshing…');
    await page.evaluate(()=>drawBoard());
    assert.equal(await page.locator('.square-refresh-outline').count(),1);
    assert.equal(await page.evaluate(()=>refreshingSquares.has('0_2')),true);
    const refreshOutput=path.join(__dirname,'test-results');fs.mkdirSync(refreshOutput,{recursive:true});
    await page.screenshot({path:path.join(refreshOutput,'square-refresh.png')});
    holdSquareRequest=false;releaseSquareRequest();

    await page.locator('.leaflet-popup-content').filter({hasText:'Older player'}).waitFor();
    await page.waitForFunction(()=>refreshingSquares.size===0);
    assert.equal(await page.locator('.square-refresh-outline').count(),0);
    assert.equal(await page.evaluate(()=>board[2].captured_by),'Older player');
    await page.selectOption('#player-filter','Older player');
    assert.equal(await page.evaluate(()=>board.filter(c=>captureVisible(c)).length),1);
    assert.equal(await page.locator('#start').inputValue(),'');
    await page.selectOption('#player-filter','');
    await page.locator('.leaflet-popup-close-button').last().click();
    console.log('Passed square API lookup: enriched older capturer, filter refresh, popup details and unchanged start input.');
    failSquareRequest=true;
    await page.evaluate(()=>showSquareDetails(board[2]));
    await page.locator('.leaflet-popup-content').filter({hasText:'Test square lookup failure'}).waitFor();
    assert.equal(await page.evaluate(()=>refreshingSquares.size),0);
    failSquareRequest=false;
    await page.locator('.leaflet-popup-close-button').last().click();
    console.log('Passed refresh highlight: visible while request waits, survives redraw and clears after success or failure.');

    const detailRequestsBefore=squareDetailRequests;
    await page.evaluate(()=>{
     squareLookupChecks.clear();map.setView([.001,.013],17,{animate:false});
     drawBoard();scheduleSquareLookups();loadNextSquare();
    });
    await page.waitForTimeout(1200);
    assert.equal(squareDetailRequests,detailRequestsBefore);
    assert.equal(await page.evaluate(()=>squareLookupTimer),null);
    assert.equal(await page.evaluate(()=>squareLookupCandidates().length),0);
    assert.equal(await page.locator('#detail-use-zoom').count(),0);
    assert.match(await page.locator('#square-lookup-status').innerText(),/temporarily disabled/);
    console.log('Passed disabled automatic refresh: no requests or timers after zooming, manual square lookup still works.');

    assert.equal(await page.locator('.team-score').first().getAttribute('data-team'),'RED');
    assert.equal(await page.locator('.team-score[data-team="BLUE"] .team-score-captures').innerText(),'2 squares held');
    assert.equal(await page.locator('.team-score[data-team="RED"] .team-score-captures').innerText(),'2 squares held');
    assert.equal(await page.locator('.team-score[data-team="GREEN"] .team-score-captures').innerText(),'1 square held');
    assert.equal(await page.locator('.team-score[data-team="PINK"] .team-score-captures').innerText(),'0 squares held');
    assert.match(await page.locator('#team-scores-source').innerText(),/Cached/);
    await page.evaluate(()=>{boardAvailable=false;feedMetadata.team_scores=null;renderTeamScores();});
    assert.equal(await page.locator('.team-score[data-team="BLUE"] .team-score-captures').innerText(),'— squares held');
    await page.evaluate(()=>{boardAvailable=true;renderTeamScores();});
    await page.locator('#toggle-captured-squares').click();
    assert.equal(await page.evaluate(()=>territories.getLayers().length),0);
    assert.equal(await page.locator('#toggle-captured-squares').innerText(),'Show captured squares');
    assert.equal(await page.locator('.team-score[data-team="BLUE"] .team-score-captures').innerText(),'2 squares held');
    await page.locator('#toggle-captured-squares').click();
    assert.equal(await page.locator('#toggle-captured-squares').innerText(),'Hide captured squares');
    await page.locator('.team-score[data-team="BLUE"] button').click();
    assert.equal(await page.locator('.team-score[data-team="BLUE"] button').getAttribute('aria-pressed'),'true');
    assert.deepEqual(await page.evaluate(()=>[...new Set(territories.getLayers().map(layer=>layer.squareData.owner_team))]),['BLUE']);
    assert.equal(await page.locator('#team').inputValue(),'BLUE');
    await page.locator('.team-score[data-team="RED"] button').click();
    assert.deepEqual(await page.evaluate(()=>[...new Set(territories.getLayers().map(layer=>layer.squareData.owner_team))]),['RED']);
    await page.locator('.team-score[data-team="RED"] button').click();
    assert.equal(await page.locator('#team-filter-clear').isVisible(),false);
    await page.locator('.team-score[data-team="GREEN"] button').click();
    await page.locator('#team-filter-clear').click();
    assert.equal(await page.evaluate(()=>mapTeamFilter),null);

   }
   if(scenario.bonus){
    assert.equal(await page.locator('.bonus-place-icon').count(),1);
    assert.match(await page.locator('.route-place-bonus').innerText(),/25 points/);
    await page.locator('[data-used-place="42"]').click();
    assert.equal(await page.evaluate(()=>excludedPlaceIds.has(42)),true);
    assert.match(await page.locator('#place-settings-status').textContent(),/Run a new search/);
    assert.equal(await page.evaluate(()=>result.routes[0].capture_value),33);
    await page.locator('[data-used-place="42"]').click();
    assert.equal(await page.evaluate(()=>excludedPlaceIds.has(42)),false);
    console.log('Passed place markers, estimated bonus breakdown, and visited-place toggles.');
   }
   await page.locator('#phone-navigation').click();
   await page.locator('#handoff-show-qr').waitFor();
   if(!scenario.failPreview){
    await page.locator('.handoff-preview-map .leaflet-overlay-pane svg').waitFor();
    assert.equal(await page.locator('.handoff-stop-icon').count(),3);
    assert.equal(await page.locator('.handoff-gap').count(),2);
    await page.locator('.handoff-gap').last().click();
    await page.locator('.handoff-fit-route').click();
   }else{
    assert.equal(await page.locator('#handoff-qr-pane').isVisible(),true);
   }
   await page.locator('#handoff-show-qr').click();
   assert.ok(await page.locator('#navigation-sections canvas').count());
   await page.locator('#gpx-create-qr').click();
   await page.locator('#gpx-qr-result:not([hidden])').waitFor();
   assert.ok((await page.locator('#gpx-qr-url').inputValue()).endsWith('/api/gpx-shares/test.gpx'));
   assert.match(await page.locator('#gpx-qr-status').innerText(),/localhost URL is not reachable/);
   assert.equal(await page.locator('.gpx-download-qr canvas').count(),1);
   if(!scenario.failPreview){
    await page.locator('#handoff-show-preview').click();
    if(scenario.name==='box'){
     const output=path.join(__dirname,'test-results');fs.mkdirSync(output,{recursive:true});
     await page.screenshot({path:path.join(output,'handoff-preview.png')});
    }
   }
   await page.locator('#navigation-close').click();
   await page.locator('#navigation-modal').waitFor({state:'detached'});
   await page.locator('#phone-navigation').click();
   await page.locator('#handoff-show-qr').waitFor();
   if(!scenario.failPreview)await page.locator('.handoff-preview-map .leaflet-overlay-pane svg').waitFor();
   await page.locator('#navigation-close').click();
   await page.locator('#navigation-modal').waitFor({state:'detached'});
   if(scenario.name==='no-area'){
    await page.selectOption('#team','RED');
    assert.equal(await page.locator('.team-score.selected').getAttribute('data-team'),'RED');
    assert.equal(await page.locator('.team-score[data-team="BLUE"] .team-score-captures').innerText(),'2 squares held');
    console.log('Passed team standings: counts, stable ties, unavailable data, cached status, and team selection.');
    await page.fill('#start','1, 1');await page.fill('#end','2, 2');
    await page.locator('#waypoint-options > summary').click();
    await page.locator('#add-waypoint').click();
    await page.locator('#waypoints input').fill('3, 3');
    await page.evaluate(area=>{allowedBounds=area;},box);
    await page.locator('#submit').click();
    await page.locator('#start[aria-invalid="true"]').waitFor();
    assert.equal(await page.locator('#end').getAttribute('aria-invalid'),'true');
    assert.equal(await page.locator('#waypoints input').getAttribute('aria-invalid'),'true');
    assert.match(await page.locator('#route-input-error').innerText(),/Waypoint W1/);
    await page.waitForFunction(()=>!searching);
    assert.equal(planRequests,0);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'start');
    await page.fill('#start','0, 0');
    assert.equal(await page.locator('#route-input-error').isVisible(),false);
    console.log('Passed outside-area preflight: named errors, invalid inputs, restored focus, no route request.');
    await page.fill('#start','Airport entrance');
    await page.evaluate(({area})=>{
     selectedLocations.start={label:'Airport entrance',coordinates:[.001,.001]};
     allowedBounds=area;excludedPlaceIds=new Set([42]);placeScoringWeek='2026-11-04';
    },{area:polygon});
    await page.locator('#place-options > summary').click();
    await page.fill('#budget','25');await page.fill('#place-remaining','50');
    await page.locator('#saved-trip-manage > summary').click();
    await page.fill('#trip-name','Airport loop');await page.locator('#save-trip').click();
    assert.equal(await page.locator('#saved-trip option').count(),2);
    await page.reload();await page.waitForFunction(()=>map&&markers&&boardAvailable);
    const savedId=await page.locator('#saved-trip option').nth(1).getAttribute('value');
    await page.selectOption('#saved-trip',savedId);await page.locator('#load-trip').click();
    assert.equal(await page.locator('#start').inputValue(),'Airport entrance');
    assert.deepEqual(await page.evaluate(()=>locationPoint('start')),[.001,.001]);
    assert.equal(await page.locator('#end').inputValue(),'2, 2');
    assert.equal(await page.locator('#waypoints input').inputValue(),'3, 3');
    assert.equal(await page.locator('#team').inputValue(),'RED');
    assert.equal(await page.locator('#budget').inputValue(),'25');
    assert.equal(await page.locator('#place-remaining').inputValue(),'50');
    assert.deepEqual(await page.evaluate(()=>allowedBounds),polygon);
    assert.deepEqual(await page.evaluate(()=>[...excludedPlaceIds]),[42]);
    assert.equal(await page.evaluate(()=>result),null);
    await page.locator('#saved-trip-manage > summary').click();
    await page.fill('#trip-name','Updated loop');await page.locator('#save-trip').click();
    assert.equal(await page.locator('#saved-trip option').count(),2);
    assert.equal(await page.locator('#saved-trip option').nth(1).innerText(),'Updated loop');
    await page.locator('#delete-trip').click();
    assert.equal(await page.locator('#saved-trip option').count(),1);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem(savedTripsKey)).length),0);
    console.log('Passed saved trips: persisted reload, resolved address, polygon, settings, waypoint order, update and delete.');
    await page.locator('[data-sidebar-target="sidebar-drive"]').click();
    await page.locator('#drive-start:not([disabled])').waitFor();
    assert.equal(await page.locator('#drive-player').inputValue(),'🥓');
    await page.locator('#drive-start').click();
    await page.locator('#drive-end:not([disabled])').waitFor();
    await page.reload();await page.locator('#drive-end:not([disabled])').waitFor();
    assert.equal(await page.locator('#drive-player').isDisabled(),true);
    driveReportFails=true;await page.locator('#drive-end').click();
    await page.waitForFunction(()=>!driveBusy);
    assert.match(await page.locator('#drive-status').innerText(),/Session retained/);
    assert.equal(await page.evaluate(()=>!!driveState.current.ended_at),true);
    driveReportFails=false;await page.locator('#drive-refresh').click();
    await page.locator('#drive-download:not([disabled])').waitFor();
    assert.match(await page.locator('#drive-report').innerText(),/2 unique squares/);
    assert.match(await page.locator('#drive-report').innerText(),/captures may be missing/);
    assert.match(await page.locator('#drive-report').innerText(),/Total earned points: unavailable/);
    const downloadPromise=page.waitForEvent('download');await page.locator('#drive-download').click();
    assert.equal((await downloadPromise).suggestedFilename(),'meshwars-drive-report.json');
    await page.locator('#drive-start').click();await page.locator('#drive-end:not([disabled])').waitFor();
    assert.equal(await page.locator('[data-drive-history]').count(),1);
    assert.equal(await page.locator('[data-drive-history]').isDisabled(),true);
    console.log('Passed drive sessions: identity defaults, reload, retained failed report, refresh, incomplete feed, download and history.');



   }
   if(scenario.name==='box'){
    await page.fill('#start','Keep start');await page.fill('#end','Keep destination');
    await page.evaluate(area=>{allowedBounds=area;},scenario.area);
    await page.locator('#clear-displayed-route').click();
    await page.locator('#route-pane').waitFor({state:'hidden'});
    assert.equal(await page.locator('#start').inputValue(),'Keep start');
    assert.equal(await page.locator('#end').inputValue(),'Keep destination');
    assert.equal(await page.evaluate(()=>result),null);
    assert.equal(await page.evaluate(()=>routeLayer.getLayers().length+targets.getLayers().length+bonusPlacesLayer.getLayers().length),0);
    assert.deepEqual(await page.evaluate(()=>allowedBounds),scenario.area);
    assert.equal(await page.locator('#search-progress').isVisible(),false);
    console.log('Passed clear displayed route while preserving trip inputs and area.');
   }
   assert.deepEqual(errors,[]);
   await page.close();
   console.log(`Passed ${scenario.name}: preview, tabs, Maps QR, GPX QR, close/reopen.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
