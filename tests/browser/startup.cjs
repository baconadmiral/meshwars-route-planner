// First paint with blocked styles/CDN, startup failures, and responsive map filters.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const scenario of ['held-assets','slow-board','missing-map','missing-bootstrap','missing-style','standalone']){
   const page=await browser.newPage({viewport:{width:scenario==='held-assets'||scenario==='standalone'?1280:390,height:900}});
   page.setDefaultTimeout(10000);
   await page.emulateMedia({colorScheme:'dark'});
   if(scenario==='standalone')await page.addInitScript(()=>Object.defineProperty(navigator,'standalone',{configurable:true,value:true}));
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   let releaseCss,releaseMap,releaseBoard;
   await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    const reply=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    if(url.hostname==='tile.openstreetmap.org')return route.fulfill({contentType:'image/png',body:tile});
    if(url.hostname==='unpkg.com'){
     if(url.pathname.endsWith('leaflet.js')){
      if(scenario==='missing-map')return route.abort();
      if(scenario==='held-assets')await new Promise(resolve=>{releaseMap=resolve;});
      return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('leaflet/dist/leaflet-src.js'))});
     }
     if(url.pathname.endsWith('leaflet.css'))return route.fulfill({contentType:'text/css',body:fs.readFileSync(require.resolve('leaflet/dist/leaflet.css'))});
     if(url.pathname.endsWith('qrcode.js'))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('qrcode-generator'))});
     return route.fulfill({contentType:'image/png',body:tile});
    }
    if(url.pathname==='/api/board'||url.pathname==='/api/board/status'){
     if(scenario==='slow-board')await new Promise(resolve=>{releaseBoard=resolve;});
     return reply({available:true,coverage:[],coverage_count:0,source:'fixture',revision:'1',attribution:{configured:false}});
    }
    if(url.pathname==='/api/version')return reply({version:'development',revision:null,changes:[]});
    if(url.pathname==='/api/players')return reply({available:false,players:[]});
    if(url.pathname==='/api/drives/status')return reply({configured:false});
    if(url.pathname==='/api/radio-coverage')return reply({available:false,configured:false,events:[]});
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(['index.html','app.js','search-client.js','startup.js','style.css'].includes(name)){
     if(name==='startup.js'&&scenario==='missing-bootstrap')return route.abort();
     if(name==='style.css'){
      if(scenario==='missing-style')return route.abort();
      if(scenario==='held-assets')await new Promise(resolve=>{releaseCss=resolve;});
     }
     return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,'static',name))});
    }
    return route.abort();
   });
   await page.goto('http://localhost:8000/',{waitUntil:'commit'});
   if(scenario!=='standalone')await page.locator('#app-loading').waitFor({state:'visible'});
   if(scenario==='held-assets'){
    assert.equal(await page.locator('#startup-title').textContent(),'Preparing your mission');
    assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('app-loading')).backgroundColor),'rgb(16, 24, 17)');
    assert.equal(await page.locator('#app-loading svg').isVisible(),true);
    assert.equal(await page.locator('#startup-retry').isVisible(),true);
    const output=path.join(__dirname,'test-results');fs.mkdirSync(output,{recursive:true});
    // Capture first paint without waiting for fonts/styles: those are deliberately blocked.
    const capture=await page.context().newCDPSession(page);
    const desktop=await capture.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(output,'startup-desktop.png'),Buffer.from(desktop.data,'base64'));
    await page.setViewportSize({width:390,height:844});
    const mobile=await capture.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(output,'startup-mobile.png'),Buffer.from(mobile.data,'base64'));
    // Wait for the browser to request both withheld assets before releasing them.
    for(let i=0;(!releaseCss||!releaseMap)&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(releaseCss&&releaseMap);releaseCss();releaseMap();
   }
   if(scenario.startsWith('missing-')){
    const expected=scenario==='missing-map'?'map could not load':scenario==='missing-style'?'appearance could not load':'Check your connection and reload';
    await page.waitForFunction(text=>document.getElementById('startup-message').textContent.includes(text),expected);
    assert.equal(await page.locator('#app-loading').isVisible(),true);
    assert.equal(await page.locator('#startup-retry').isVisible(),true);
   }else{
    await page.locator('#app-loading').waitFor({state:'hidden'});
    assert.equal(await page.locator('#map').isVisible(),true);
    if(scenario==='slow-board'){
     assert.equal(await page.locator('#submit').isDisabled(),true);
     assert.match(await page.locator('#status').textContent(),/Waiting for capture data/);
     assert.ok(releaseBoard);releaseBoard();
    }
    await page.waitForFunction(()=>boardAvailable&&!document.getElementById('submit').disabled);
    assert.equal(await page.locator('#map-filters #capture-days').count(),1);
    assert.equal(await page.locator('#capture-days').count(),1);
    const alignment=await page.evaluate(()=>({filter:document.getElementById('map-filters').getBoundingClientRect().bottom,map:document.getElementById('map').getBoundingClientRect().top}));
    assert.ok(Math.abs(alignment.filter-alignment.map)<2,'Map filter must sit directly above the map');
    await page.locator('#capture-days').evaluate(input=>{input.value='7';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.waitForFunction(()=>document.getElementById('capture-days-value').value==='7 days');
    if(scenario==='held-assets'){
     await page.setViewportSize({width:1280,height:1000});
     await page.waitForFunction(()=>document.querySelector('aside #capture-days')!==null);
     assert.equal(await page.locator('#capture-days').inputValue(),'7');
     await page.setViewportSize({width:390,height:844});
     await page.waitForFunction(()=>document.querySelector('#map-filters #capture-days')!==null);
     assert.equal(await page.locator('#capture-days').inputValue(),'7');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   }
   assert.deepEqual(errors,[]);
   await page.close();console.log(`Passed startup ${scenario}: visible splash/recovery and map-filter placement.`);
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
