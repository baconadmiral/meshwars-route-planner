// Intentional stop placement and compact installed-app location controls.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const scenario of ['desktop','mobile','pwa']){
   const page=await browser.newPage({viewport:{width:scenario==='desktop'?1280:390,height:900},hasTouch:scenario!=='desktop'});
   page.setDefaultTimeout(10000);
   await page.addInitScript(installed=>{
    if(installed)Object.defineProperty(navigator,'standalone',{value:true});
    Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition(success,error){
     if(window.testGeoFailure)error({code:1});
     else success({coords:{latitude:40.7,longitude:-111.9,accuracy:15}});
    }}});
   },scenario==='pwa');
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
   await page.goto('http://localhost:8000/');
   await page.locator('#app-loading').waitFor({state:'hidden'});
   await page.locator('#start').fill('40.7, -111.9');await page.locator('#end').fill('40.8, -111.8');
   const values=()=>page.evaluate(()=>[document.getElementById('start').value,document.getElementById('end').value]);
   const original=await values();
   await page.evaluate(()=>map.fire('click',{latlng:L.latLng(41,-112)}));
   assert.deepEqual(await values(),original,'An unarmed map tap must not edit endpoints');
   await page.locator('#start').click();
   assert.equal(await page.evaluate(()=>mapPickTarget),'start');
   assert.equal(await page.locator('#start-map').getAttribute('aria-pressed'),'true');
   await page.locator('#map').scrollIntoViewIfNeeded();
   let box=await page.locator('#map').boundingBox();
   const x=box.x+box.width*.65,y=box.y+box.height*.5;
   await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+50,y+50,{steps:6});await page.mouse.up();
   await page.evaluate(()=>map.fire('click',{latlng:L.latLng(42,-113)}));
   assert.deepEqual(await values(),original,'Dragging and its trailing click must not place a stop');
   assert.equal(await page.evaluate(()=>mapPickTarget),'start');
   if(scenario!=='desktop'){
    const client=await page.context().newCDPSession(page);
    box=await page.locator('#map').boundingBox();
    const cx=box.x+box.width*.55,cy=box.y+box.height*.55;
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx-30,y:cy,id:1},{x:cx+30,y:cy,id:2}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx-55,y:cy,id:1},{x:cx+55,y:cy,id:2}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.evaluate(()=>map.fire('click',{latlng:L.latLng(43,-114)}));
    assert.deepEqual(await values(),original,'Pinching must not place a stop');
   }
   // A new intentional pointer tap immediately after a drag is still accepted.
   box=await page.locator('#map').boundingBox();
   const tapX=box.x+box.width*.7,tapY=box.y+box.height*.65;
   if(scenario==='desktop')await page.mouse.click(tapX,tapY);else await page.touchscreen.tap(tapX,tapY);
   await page.waitForFunction(()=>mapPickTarget==='end');
   const afterStart=await values();assert.notEqual(afterStart[0],original[0]);assert.equal(afterStart[1],original[1]);
   await page.evaluate(()=>map.fire('click',{latlng:L.latLng(41.2,-111.2)}));
   assert.equal(await page.locator('#end').inputValue(),'41.200000, -111.200000');
   assert.equal(await page.evaluate(()=>mapPickTarget),null);
   const pair=await values();
   await page.evaluate(()=>map.fire('click',{latlng:L.latLng(44,-115)}));
   assert.deepEqual(await values(),pair,'A third map click must not start a new pair');
   await page.locator('#end').click();
   await page.evaluate(()=>map.fire('click',{latlng:L.latLng(41.3,-111.3)}));
   assert.equal((await values())[0],pair[0]);assert.equal((await values())[1],'41.300000, -111.300000');
   const finalPair=await values();
   await page.locator('#start-map').click();await page.keyboard.press('Escape');
   await page.evaluate(()=>map.fire('click',{latlng:L.latLng(45,-116)}));
   assert.deepEqual(await values(),finalPair);
   await page.locator('#start-map').click();await page.locator('#cancel-map-pick').click();
   assert.equal(await page.evaluate(()=>mapPickTarget),null);
   await page.locator('#start').click();await page.locator('#start').fill('40.6, -111.6');
   assert.equal(await page.evaluate(()=>mapPickTarget),null,'Typing coordinates must cancel map selection');
   await page.locator('#start').click();await page.locator('#start-lookup').click();
   await page.waitForFunction(()=>!searching);
   assert.equal(await page.evaluate(()=>mapPickTarget),null,'Address lookup must cancel map selection');
   const beforeLocation=await values();
   await page.getByRole('button',{name:'My location',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('.current-location-status').dataset.state==='success');
   assert.deepEqual(await values(),beforeLocation,'Locating the device must not edit route endpoints');
   assert.equal(await page.locator('.current-location-label').isVisible(),scenario!=='pwa');
   if(scenario==='pwa'){
    const statusBox=await page.locator('.current-location-status').boundingBox();
    assert.ok(statusBox.width<=1&&statusBox.height<=1,'Successful accuracy text must not occupy map space');
    assert.ok((await page.locator('.current-location-button').boundingBox()).width<=50);
   }else assert.match(await page.locator('.current-location-status').innerText(),/accuracy about 15 m/);
   await page.evaluate(()=>window.testGeoFailure=true);
   await page.getByRole('button',{name:'My location',exact:true}).click();
   assert.match(await page.locator('.current-location-status').innerText(),/Location access denied/);
   assert.ok((await page.locator('.current-location-status').boundingBox()).height>1,'Location errors remain visible');
   assert.deepEqual(errors,[]);
   const output=path.join(__dirname,'test-results');fs.mkdirSync(output,{recursive:true});
   await page.screenshot({path:path.join(output,`map-controls-${scenario}.png`)});
   await page.close();console.log(`Passed ${scenario}: explicit Start/Finish, drag/pinch guards, automatic Finish, cancellation, typing/lookup and compact PWA location control.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
