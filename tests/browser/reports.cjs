// Standalone report UI checks; no live API, map tiles, or external libraries.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const teams=['BLUE','RED','GREEN','PURPLE','YELLOW','ORANGE','PINK'];
const days=Array.from({length:30},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,teams:Object.fromEntries(teams.map(team=>[team,team==='BLUE'?i:0])),total:i}));
const fixture={available:true,teams,days,total:435,start_date:'2026-10-01',end_date:'2026-10-30',board_updated_at:1793404800,missing_capture_time_count:12,outside_window_count:20,unknown_team_count:0,stale:false};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const viewport of [{width:1280,height:1000},{width:390,height:844}]){
   const page=await browser.newPage({viewport});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   let mode='success',requests=0;
   await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/reports/territory'){
     requests++;
     if(mode==='failure')return route.fulfill({status:503,body:'Unavailable'});
     const data=mode==='unavailable'?{available:false,error:'Waiting for board'}:{...fixture,stale:mode==='stale'};
     return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    }
    const name=url.pathname==='/reports'?'reports.html':url.pathname.slice(1);
    if(['reports.html','reports.js','style.css','reports.css'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
    return route.abort();
   });
   await page.goto('http://localhost:8000/reports');
   await page.locator('#report-content').waitFor({state:'visible'});
   assert.equal(await page.locator('#report-total').textContent(),'435');
   assert.equal(await page.locator('#report-table tbody tr').count(),30);
   assert.equal(await page.locator('#report-chart polyline').count(),7);
   assert.match(await page.locator('#report-chart circle').first().getAttribute('aria-label'),/BLUE.*2026-10-01.*0 territory points/);
   await page.getByLabel('BLUE',{exact:true}).uncheck();
   assert.equal(await page.locator('#report-chart polyline').count(),6);
   for(const team of teams.slice(1))await page.getByLabel(team,{exact:true}).uncheck();
   assert.match(await page.locator('#report-chart').textContent(),/Select a team/);
   await page.getByLabel('BLUE',{exact:true}).check();
   mode='stale';await page.locator('#refresh-report').click();
   await page.waitForFunction(()=>document.getElementById('report-status').textContent.includes('Cached/stale'));
   mode='failure';await page.locator('#refresh-report').click();
   await page.waitForFunction(()=>document.getElementById('report-status').textContent.includes('previous report remains'));
   assert.equal(await page.locator('#report-content').isVisible(),true);
   mode='unavailable';await page.locator('#refresh-report').click();
   await page.locator('#report-content').waitFor({state:'hidden'});
   assert.equal(await page.locator('#report-status').textContent(),'Waiting for board');
   mode='success';await page.locator('#refresh-report').click();
   await page.locator('#report-content').waitFor({state:'visible'});
   await page.locator('#theme-toggle').click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'No horizontal page overflow');
   assert.equal(await page.evaluate(()=>document.querySelector('footer').getBoundingClientRect().top>=document.getElementById('report-table').getBoundingClientRect().bottom),true,'Footer must follow the full report, without clipping the table');
   assert.equal(requests,5);
   assert.deepEqual(errors,[]);
   const output=path.join(__dirname,'test-results');fs.mkdirSync(output,{recursive:true});
   await page.screenshot({path:path.join(output,`reports-${viewport.width}.png`),fullPage:true});
   await page.close();console.log(`Passed reports at ${viewport.width}px: chart toggles, table, stale, errors, unavailable and layout.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
