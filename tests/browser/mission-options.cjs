// Current-position start and six objective-based route cards in installed/mobile layouts.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/mission-options.json'),'utf8'));
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:950}});page.setDefaultTimeout(10000);
   await page.addInitScript(installed=>{
    if(installed)Object.defineProperty(navigator,'standalone',{value:true});
    Object.defineProperty(navigator,'onLine',{get:()=>true});
    Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(success,error){
     if(window.gpsMode==='denied')error({code:1});
     else if(window.gpsMode==='wait')window.finishGPS=()=>success({coords:{latitude:.001,longitude:.001,accuracy:8}});
     else success({coords:{latitude:.001,longitude:.001,accuracy:8}});
    }}});
   },width===390);
   const errors=[];page.on('pageerror',error=>errors.push(error.message));let payload;
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
    if(url.pathname.startsWith('/api/searches/')){if(route.request().method()==='POST')payload=route.request().postDataJSON();return reply({state:'complete',result:fixture});}
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(['index.html','app.js','search-client.js','startup.js','style.css'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
    return route.abort();
   });
   await page.goto('http://localhost:8000/');await page.locator('#app-loading').waitFor({state:'hidden'});
   assert.equal(await page.locator('#mission-mode').inputValue(),'all');
   assert.equal(await page.locator('#strategy-options').isVisible(),false);
   await page.locator('#end').fill('0.001, 0.01');
   await page.locator('#start-current').click();
   await page.waitForFunction(()=>!locatingStart);
   assert.equal(await page.locator('#start').inputValue(),'0.001000, 0.001000');
   assert.equal(await page.locator('#end').inputValue(),'0.001, 0.01');
   assert.match(await page.locator('#start-location-status').innerText(),/Start set to your current location/);
   await page.evaluate(()=>window.gpsMode='denied');
   await page.locator('#start-current').click();
   await page.waitForFunction(()=>!locatingStart);
   assert.match(await page.locator('#start-location-status').innerText(),/Location access denied/);
   assert.equal(await page.locator('#start').inputValue(),'0.001000, 0.001000');
   await page.evaluate(()=>window.gpsMode='wait');
   await page.locator('#start-current').click();
   await page.locator('#start').fill('0.001, 0.002');await page.evaluate(()=>window.finishGPS());
   await page.waitForFunction(()=>!locatingStart);
   assert.equal(await page.locator('#start').inputValue(),'0.001, 0.002','An edited Start must survive a late GPS result');
   await page.evaluate(()=>window.gpsMode='ok');await page.locator('#start-current').click();await page.waitForFunction(()=>!locatingStart);
   await page.locator('#start-current').scrollIntoViewIfNeeded();
   fs.mkdirSync(path.join(__dirname,'test-results'),{recursive:true});
   await page.screenshot({path:path.join(__dirname,`test-results/gps-start-${width}.png`)});
   await page.locator('#submit').click();await page.waitForFunction(()=>!searching&&result?.mission_options);
   assert.equal(payload.mission_mode,'all');assert.deepEqual(payload.start,[.001,.001]);
   assert.equal(await page.locator('.card').count(),6);
   for(const choice of fixture.mission_options){
    const card=page.locator(`.card[data-mission="${choice.mode}"]`);
    assert.match(await card.innerText(),new RegExp(choice.name));
    if(choice.available){await card.click();assert.match(await page.locator('.mission-brief').innerText(),new RegExp(choice.name));assert.match(await page.locator('.route-value h3').innerText(),new RegExp(choice.name));}
   }
   const unavailable=structuredClone(fixture);const special=unavailable.mission_options.find(c=>c.mode==='special_ops');special.available=false;special.message='No eligible place bonuses in this area.';
   await page.evaluate(data=>{result=data;showRoute(0);},unavailable);
   assert.equal(await page.locator('.card[data-mission="special_ops"]').isDisabled(),true);
   assert.match(await page.locator('.card[data-mission="special_ops"]').innerText(),/No eligible place bonuses/);
   await page.locator('#map-divider').focus();await page.keyboard.press('Home');
   await page.evaluate(()=>document.getElementById('route-pane').scrollTop=0);
   await page.locator('#route-pane').scrollIntoViewIfNeeded();
   fs.mkdirSync(path.join(__dirname,'test-results'),{recursive:true});
   await page.screenshot({path:path.join(__dirname,`test-results/mission-options-${width}.png`)});
   assert.deepEqual(errors,[]);
   await page.close();console.log(`Passed GPS mission options at ${width}px: current Start, denial, late results, six named cards, per-route briefing and unavailable objective.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
