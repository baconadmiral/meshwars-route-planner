'use strict';
const $ = id => document.getElementById(id);
let board = [], result = null, routeIndex = 0, clickCount = 0;
const colors = {BLUE:'#1656e8',RED:'#e44444',GREEN:'#2e9e65',PURPLE:'#8858be',YELLOW:'#d2a716',ORANGE:'#e88032',PINK:'#db6aa5'};
let map, territories, routeLayer, markers, targets;
let searching = false, searchController = null;
const selectedLocations = {};
let tripLabels = null;
$('cancel-search').onclick = () => searchController?.abort();
const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
let explicitTheme=null;
try{const saved=localStorage.getItem('blue-theme');if(saved==='dark'||saved==='light')explicitTheme=saved;}catch{}
function applyTheme(theme){
 document.documentElement.dataset.theme=theme;
 $('theme-toggle').setAttribute('aria-pressed',String(theme==='dark'));
 $('theme-toggle').title=theme==='dark'?'Switch to light mode':'Switch to dark mode';
 window.dispatchEvent(new Event('squarethemechange'));
}
$('theme-toggle').onclick=()=>{
 explicitTheme=document.documentElement.dataset.theme==='dark'?'light':'dark';
 try{localStorage.setItem('blue-theme',explicitTheme);}catch{}
 applyTheme(explicitTheme);
};
systemTheme.addEventListener('change',event=>{if(!explicitTheme)applyTheme(event.matches?'dark':'light');});
applyTheme(explicitTheme||(systemTheme.matches?'dark':'light'));
const miles = m => `${(m/1609.344).toFixed(1)} mi`;
const minutes = s => `${Math.ceil(s/60)} min`;
const escape = text => String(text).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function coordinates(value){
 const p=value.split(',').map(x=>x.trim());
 if(p.length!==2 || p.some(x=>!x || !Number.isFinite(Number(x)))) throw Error('Enter each location as latitude, longitude, or select it on the map.');
 const [lat,lon]=p.map(Number);
 if(Math.abs(lat)>90 || Math.abs(lon)>180) throw Error('Latitude must be within ±90 and longitude within ±180.');
 return [lon,lat];
}
function locationPoint(id){
 const selected=selectedLocations[id];
 if(selected && selected.label===$(id).value.trim())return selected.coordinates;
 return coordinates($(id).value);
}
function clearAddress(id){
 delete selectedLocations[id];$(id+'-matches').replaceChildren();
}
async function resolveLocation(id,signal){
 try{return locationPoint(id);}catch(error){
  // Numeric coordinate pairs with invalid ranges should remain validation errors.
  if(/^\s*[+-]?[\d.]+\s*,\s*[+-]?[\d.]+\s*$/.test($(id).value))throw error;
 }
 const query=$(id).value.trim();
 if(query.length<3)throw Error('Enter an address or latitude, longitude for both locations.');
 const choices=$(id+'-matches');choices.textContent='Looking up address…';
 const response=await fetch('/api/geocode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query}),signal});
 const data=await response.json();
 if(!response.ok){choices.textContent=data.error;throw Error(data.error||'Address lookup failed.');}
 choices.replaceChildren();
 if(!data.results.length){choices.textContent='No matches. Add city, state, or ZIP code, or use coordinates.';return null;}
 const title=document.createElement('p');title.textContent='Choose the correct location:';choices.append(title);
 for(const match of data.results){
  const button=document.createElement('button');button.type='button';button.textContent=match.label;
  button.onclick=()=>{
   $(id).value=match.label;selectedLocations[id]=match;
   choices.textContent=`Selected: ${match.coordinates[1].toFixed(6)}, ${match.coordinates[0].toFixed(6)}`;
   updateMarkers();map.panTo([match.coordinates[1],match.coordinates[0]]);
   $('status').textContent='Location selected. Confirm the other endpoint, then find BLUE opportunities.';
  };
  choices.append(button);
 }
 return null;
}
for(const id of ['start','end']){
 $(id).addEventListener('input',()=>{clearAddress(id);if(markers)updateMarkers();});
 $(id+'-lookup').onclick=async()=>{
  if(searching)return;
  searchController=new AbortController();setSearching(true);
  $('search-progress').hidden=false;$('progress-bar').value=0;$('progress-percent').textContent='';
  $('progress-stage').textContent='Looking up address…';$('progress-time').textContent='Address lookup may take up to 15 seconds.';
  try{
   const p=await resolveLocation(id,searchController.signal);
   if(p){updateMarkers();map.panTo([p[1],p[0]]);$('status').textContent='Location ready.';}
   else $('status').textContent='Choose a matching address below the input, or refine the address.';
   $('progress-stage').textContent='Address lookup complete';
  }catch(error){$('status').textContent=error.name==='AbortError'?'Address lookup cancelled.':error.message;$('progress-stage').textContent='Address lookup stopped';}
  finally{searchController=null;setSearching(false);}
 };
}
function updateMarkers(){
 markers.clearLayers();
 for(const [id,label] of [['start','A'],['end','B']]){
  try{const p=locationPoint(id);L.marker([p[1],p[0]]).addTo(markers).bindTooltip(label,{permanent:true});}catch{}
 }
}
function holdingScore(cell){
 const value=cell?.scores?.[cell.owner_team];
 return typeof value==='number' && Number.isFinite(value) && value>=0 ? value : null;
}
function scoreLabel(cell){
 const points=holdingScore(cell);
 return points===null?'owner score unknown':`${points.toLocaleString(undefined,{maximumFractionDigits:3})} owner points`;
}
const utility=value=>Number(value||0).toLocaleString(undefined,{maximumFractionDigits:4});
let squareDarkness=80;
let squareContrast=70;
let captureDays=0;
try{
 const saved=localStorage.getItem('blue-square-darkness');
 if(saved!==null && saved.trim()!=='' && Number.isFinite(Number(saved)) && Number(saved)>=0 && Number(saved)<=100)squareDarkness=Number(saved);
}catch{}
try{
 const saved=localStorage.getItem('blue-square-contrast');
 if(saved!==null && saved.trim()!=='' && Number.isFinite(Number(saved)) && Number(saved)>=0 && Number(saved)<=100)squareContrast=Number(saved);
}catch{}
try{
 const saved=localStorage.getItem('blue-capture-days');
 if(saved!==null && saved.trim()!=='' && Number.isInteger(Number(saved)) && Number(saved)>=0 && Number(saved)<=60)captureDays=Number(saved);
}catch{}
let squareStyleFrame=null;
function updateSquareDarkness(immediate=false){
 $('square-darkness-value').value=`${Math.round(squareDarkness)}%`;
 $('square-contrast-value').value=`${Math.round(squareContrast)}%`;
 const captureLabel=captureDays===0?'All time':`${captureDays} ${captureDays===1?'day':'days'}`;
 $('capture-days-value').value=captureLabel;
 $('capture-days').setAttribute('aria-valuetext',captureDays===0?'Show all captures':`Captured in the last ${captureLabel}`);
 // Update the legend with the same score shading as the actual squares.
 document.querySelectorAll('.score-swatches i').forEach((swatch,index)=>{
  const points=[.1,1,3][index];
  const style=squareStyle({owner_team:'BLUE',scores:{BLUE:points}});
  swatch.style.backgroundColor=style.fillColor.replace('rgb(','rgba(').replace(')',`,${style.fillOpacity})`);
  swatch.style.borderColor=style.fillOpacity===0?style.color:'transparent';
 });
 if(immediate){
  if(squareStyleFrame!==null)cancelAnimationFrame(squareStyleFrame);
  squareStyleFrame=null;drawBoard();return;
 }
 if(squareStyleFrame!==null)return;
 squareStyleFrame=requestAnimationFrame(()=>{
  squareStyleFrame=null;
  // Rebuild visible layers so Leaflet Canvas repaints every fill without a zoom.
  drawBoard();
 });
}
$('square-darkness').value=String(squareDarkness);
$('square-darkness').addEventListener('input',event=>{
 squareDarkness=Number(event.target.value);updateSquareDarkness();
});
$('square-darkness').addEventListener('change',()=>{
 squareDarkness=Number($('square-darkness').value);updateSquareDarkness(true);
 try{localStorage.setItem('blue-square-darkness',String(squareDarkness));}catch{}
});
$('square-contrast').value=String(squareContrast);
$('square-contrast').addEventListener('input',event=>{
 squareContrast=Number(event.target.value);updateSquareDarkness();
});
$('square-contrast').addEventListener('change',()=>{
 squareContrast=Number($('square-contrast').value);updateSquareDarkness(true);
 try{localStorage.setItem('blue-square-contrast',String(squareContrast));}catch{}
});
$('capture-days').value=String(captureDays);
$('capture-days').addEventListener('input',event=>{
 captureDays=Number(event.target.value);updateSquareDarkness();
});
$('capture-days').addEventListener('change',()=>{
 captureDays=Number($('capture-days').value);updateSquareDarkness(true);
 try{localStorage.setItem('blue-capture-days',String(captureDays));}catch{}
});
updateSquareDarkness();
window.addEventListener('squarethemechange',()=>updateSquareDarkness(true));
function squareStyle(cell){
 const points=holdingScore(cell);
 // Visual saturation at 3 points; full scores still drive route ranking.
 const strength=points===null?0:Math.min(1,points/3);
 const base=colors[cell.owner_team]||'#888888';
 const intensity=squareDarkness/100,contrast=squareContrast/100;
 const darkMode=document.documentElement.dataset.theme==='dark';
 const rgb=[1,3,5].map(index=>{
  const channel=parseInt(base.slice(index,index+2),16);
  // Keep team hues muted without the pale, white-heavy fills of the old scale.
  return Math.round(channel*(darkMode ? .9 : .85)*(1-.12*contrast*strength));
 });
 const scoreOpacity=(1-contrast)+contrast*(.12+.88*strength);
 return {color:base,stroke:intensity===0,weight:.6,opacity:.4,
         fillColor:`rgb(${rgb.join(',')})`,fillOpacity:intensity*scoreOpacity};
}
function captureVisible(cell,now=Date.now()/1000){
 if(captureDays===0)return true;
 const captured=cell?.captured_at;
 return typeof captured==='number' && Number.isFinite(captured) && captured>0 &&
        captured<=now && captured>=now-captureDays*86400;
}
function drawBoard(){
 if(!map || !board.length)return;
 territories.clearLayers();
 const bounds=map.getBounds();
 const now=Date.now()/1000;
 const eligible=board.filter(c=>captureVisible(c,now));
 $('capture-filter-status').textContent=`${eligible.length.toLocaleString()} of ${board.length.toLocaleString()} squares match across all teams.${captureDays>0?' Missing or future capture times are hidden.':''}`;
 const visible=eligible.filter(c=>bounds.intersects([[c.south,c.west],[c.north,c.east]]));
 if(targets && result?.routes?.[routeIndex])drawRouteTargets(result.routes[routeIndex]);
 if(visible.length>2500){return;}
 for(const c of visible){
  const rect=L.rectangle([[c.south,c.west],[c.north,c.east]],squareStyle(c)).addTo(territories);
  rect.squareData=c;
  rect.on('mouseover',()=>rect.setStyle({stroke:true,color:colors[c.owner_team]||'#888888',weight:1,opacity:.75}));
  rect.on('mouseout',()=>rect.setStyle(squareStyle(c)));
  const captured=typeof c.captured_at==='number' && Number.isFinite(c.captured_at) && c.captured_at>0 ? ` · Captured ${new Date(c.captured_at*1000).toLocaleString()}` : '';
  rect.bindTooltip(`${escape(c.owner_team)} · ${escape(c.cell_id)} · ${scoreLabel(c)}${captured}`);
 }
 // Rebuilt fills must stay beneath target outlines and the selected route.
 if(targets)targets.eachLayer(layer=>layer.bringToFront?.());
 if(routeLayer)routeLayer.eachLayer(layer=>layer.bringToFront?.());
}
function instruction(step){
 const m=step.maneuver, road=step.name ? ` onto ${step.name}` : '';
 if(m.type==='depart')return `Start${step.name ? ` on ${step.name}` : ' driving'}`;
 if(m.type==='arrive')return 'Arrive at this stop';
 if(m.type.includes('roundabout') || m.type==='rotary')return `Enter the roundabout${m.exit ? ` and take exit ${m.exit}` : ''}${road}`;
 if(m.type==='new name')return `Continue${road}`;
 if(m.type==='merge')return `Merge ${m.modifier||''}${road}`;
 if(m.type==='on ramp')return `Take the ramp ${m.modifier||''}${road}`;
 if(m.type==='off ramp')return `Take the exit ${m.modifier||''}${road}`;
 if(m.type==='fork')return `Keep ${m.modifier||'ahead'}${road}`;
 if(m.type==='end of road')return `At the end of the road, turn ${m.modifier||''}${road}`;
 return `${m.modifier==='uturn' ? 'Make a U-turn' : m.modifier && m.modifier!=='straight' ? `Turn ${m.modifier}` : 'Continue straight'}${road}`;
}
function showComparison(){
 const container=$('comparison'),strategies=result.strategy_results;
 container.hidden=!strategies;
 if(!strategies){container.replaceChildren();return;}
 const greedy=strategies.greedy.routes[0],beam=strategies.beam.routes[0];
 const difference=(beam?.capture_value||0)-(greedy?.capture_value||0);
 const rows=['greedy','beam'].map(mode=>{
  const entry=strategies[mode],best=entry.routes[0];
  return `<tr class="${result.strategy===mode?'active':''}"><td>${mode==='beam'?`Beam (width ${entry.stats.beam_width})`:'Greedy'}</td><td>${utility(best?.capture_value)}<small>${best?.target_count||0} raw targets</small></td><td>${best?minutes(best.duration):'—'}</td><td>${entry.stats.refinement_requests}</td><td><button data-strategy="${mode}" aria-pressed="${result.strategy===mode}">Show route</button></td></tr>`;
 }).join('');
 container.innerHTML=`<h2>Beam vs. greedy</h2><table class="comparison-table"><thead><tr><th>Method</th><th>Weighted value</th><th>Driving time</th><th>Refinement checks</th><th>Map</th></tr></thead><tbody>${rows}</tbody></table><p class="fine">Beam ${difference>1e-8?`found ${utility(difference)} more weighted value`:difference< -1e-8?`found ${utility(-difference)} less weighted value`:'matched the weighted value'}. Same endpoints, snapshot, initial candidates, and driving budget. ${result.total_provider_requests} provider requests in total; matching requests reused. Beam has a larger search allowance. Target counts are not confirmed captures.</p>`;
 container.querySelectorAll('[data-strategy]').forEach(button=>button.onclick=()=>{
  const mode=button.dataset.strategy;
  result={...result,...strategies[mode],strategy:mode};showComparison();showActiveResult();$('status').textContent=`Showing ${mode} results: ${result.routes.length} route options. Capture is not guaranteed.`;
 });
}
function setPlanVisibility(visible){
 const workspace=document.querySelector('.workspace');
 $('route-pane').hidden=!visible;$('map-divider').hidden=!visible;
 workspace.classList.toggle('plan-hidden',!visible);
 workspace.dispatchEvent(new Event('routepanelchange'));
 if(map)map.invalidateSize({pan:false});
}
function showActiveResult(){
 const hasRoutes=result.routes.length>0 || Object.values(result.strategy_results||{}).some(entry=>entry.routes.length>0);
 setPlanVisibility(hasRoutes);
 if(result.no_opportunities){
  routeLayer.clearLayers();targets.clearLayers();
  $('results').innerHTML='<div class="empty"><h2>No useful route found</h2><p>This search found no target squares within the budget. Try the other strategy or a larger detour budget.</p></div>';
 }else showRoute(0);
}
function drawRouteTargets(r){
 targets.clearLayers();
 const known = new Map(board.map(c=>[c.cell_id,c]));
 for(const id of r.target_ids){
  const cell=known.get(id);
  if(!captureVisible(cell))continue;
  const [row,col]=id.split('_').map(Number);
  const bounds=cell ? [[cell.south,cell.west],[cell.north,cell.east]] : [[row*.0027,col*.00384],[(row+1)*.0027,(col+1)*.00384]];
  L.rectangle(bounds,{color:'#15966c',weight:2,dashArray:cell?null:'4 4',fillOpacity:cell?0:.18}).addTo(targets).bindTooltip(cell?`Enemy target · ${escape(cell.owner_team)} · ${scoreLabel(cell)}`:'Unpainted exploration · coverage unknown');
 }
}
function showRoute(index){
 routeIndex=index;
 const r=result.routes[index], base=result.baseline;
 routeLayer.clearLayers();
 targets.clearLayers();
 drawRouteTargets(r);
 L.geoJSON(base.geometry,{style:{color:'#8494aa',weight:5,opacity:.55}}).addTo(routeLayer);
 const line=L.geoJSON(r.geometry,{style:{color:'#1656e8',weight:5,opacity:.95}}).addTo(routeLayer);
 map.fitBounds(line.getBounds(),{padding:[25,25]});
 const cards=result.routes.map((v,i)=>`<button class="card ${i===index?'selected':''}" data-route="${i}" aria-pressed="${i===index}">${i===0?'Best BLUE opportunity':`Alternative ${i+1}`}<b>${utility(v.capture_value)} priority value</b><small>${v.target_count} raw targets · ${v.easy_enemy_count} easy enemy<br>${v.hard_enemy_count} defended · ${v.unknown_score_count} unknown score · ${v.unmapped_count} unpainted<br>${minutes(v.duration)} · ${miles(v.distance)}<br>+${minutes(Math.max(0,v.duration-base.duration))} vs fastest</small></button>`).join('');
 const steps=[];
 r.legs.forEach((leg,legIndex)=>leg.steps.forEach(step=>{
  let text=instruction(step);
  if(step.maneuver.type==='arrive')text=legIndex===r.legs.length-1?'Arrive at destination B':'Reach detour waypoint; continue to the next leg';
  steps.push(`<li><span>${escape(text)}</span><small>${miles(step.distance)}</small></li>`);
 }));
 $('results').innerHTML=`<div class="cards">${cards}</div><div class="routehead"><h2>Your driving directions</h2><button id="download">Download route GeoJSON</button></div><p class="trip">A: ${escape(tripLabels?.start||$('start').value)} → B: ${escape(tripLabels?.end||$('end').value)}<br>${minutes(r.duration)} · ${miles(r.distance)} · ${utility(r.capture_value)} weighted value<br>${r.easy_enemy_count} easy enemy · ${r.hard_enemy_count} defended enemy · ${r.unknown_score_count} unknown score<br>${r.enemy_count} enemy + ${r.unmapped_count} unpainted / ${r.square_count} squares crossed<br>Fastest baseline: ${minutes(base.duration)} · ${miles(base.distance)} · ${base.target_count} target squares · ${utility(base.capture_value)} weighted value</p><ol class="steps">${steps.join('')}</ol>`;
 document.querySelectorAll('[data-route]').forEach(el=>el.onclick=()=>showRoute(Number(el.dataset.route)));
 $('download').onclick=()=>{
  const blob=new Blob([JSON.stringify({type:'Feature',geometry:r.geometry,properties:{team:'BLUE',duration_seconds:r.duration,target_count:r.target_count,capture_value:r.capture_value,easy_enemy_count:r.easy_enemy_count,hard_enemy_count:r.hard_enemy_count}},null,2)],{type:'application/geo+json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='blue-route.geojson';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
}
function initPanelResize(){
 const workspace=document.querySelector('.workspace'),divider=$('map-divider');
 let ratio=.6,dragging=false,frame=null;
 try{const saved=Number(localStorage.getItem('blue-map-split'));if(saved>0 && saved<1)ratio=saved;}catch{}
 function bounds(){
  const available=Math.max(0,workspace.clientHeight-divider.offsetHeight);
  const minimum=Math.min(160,available/2);
  return {available,minimum,maximum:Math.max(minimum,available-120)};
 }
 function redrawMap(){
  if(frame!==null)return;
  frame=requestAnimationFrame(()=>{frame=null;if(map)map.invalidateSize({pan:false});});
 }
 function apply(height,save=false){
  if($('route-pane').hidden){redrawMap();return;}
  const b=bounds();
  if(!b.available)return;
  const pixels=Math.max(b.minimum,Math.min(b.maximum,height));
  ratio=pixels/b.available;
  workspace.style.setProperty('--map-height',`${pixels}px`);
  divider.setAttribute('aria-valuemin',String(Math.round(b.minimum)));
  divider.setAttribute('aria-valuemax',String(Math.round(b.maximum)));
  divider.setAttribute('aria-valuenow',String(Math.round(pixels)));
  divider.setAttribute('aria-valuetext',`Map ${Math.round(ratio*100)} percent of panel height`);
  if(save){try{localStorage.setItem('blue-map-split',String(ratio));}catch{}}
  redrawMap();
 }
 divider.addEventListener('pointerdown',event=>{
  if(event.button!==0)return;
  event.preventDefault();divider.focus();dragging=true;
  divider.setPointerCapture(event.pointerId);document.body.classList.add('resizing-panels');
 });
 divider.addEventListener('pointermove',event=>{
  if(!dragging)return;
  apply(event.clientY-workspace.getBoundingClientRect().top-divider.offsetHeight/2);
 });
 function finish(){
  if(!dragging)return;
  dragging=false;document.body.classList.remove('resizing-panels');
  apply(ratio*bounds().available,true);
 }
 divider.addEventListener('pointerup',finish);
 divider.addEventListener('pointercancel',finish);
 divider.addEventListener('lostpointercapture',finish);
 divider.addEventListener('dblclick',()=>apply(.6*bounds().available,true));
 divider.addEventListener('keydown',event=>{
  const b=bounds(),current=ratio*b.available,step=event.shiftKey?80:24;
  const heights={ArrowUp:current-step,ArrowDown:current+step,Home:b.minimum,End:b.maximum};
  if(!(event.key in heights))return;
  event.preventDefault();apply(heights[event.key],true);
 });
 const resize=()=>apply(ratio*bounds().available);
 workspace.addEventListener('routepanelchange',resize);
 if(window.ResizeObserver)new ResizeObserver(resize).observe(workspace);
 else window.addEventListener('resize',resize);
 window.addEventListener('beforeprint',redrawMap);
 window.addEventListener('afterprint',resize);
 resize();
}
async function init(){
 if(!window.L){$('status').textContent='Map library could not load. Check access to unpkg.com and reload.';$('submit').disabled=true;return;}
 map=L.map('map',{preferCanvas:true}).setView([40.6,-111.9],10);
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
 initPanelResize();
 territories=L.layerGroup().addTo(map);routeLayer=L.layerGroup().addTo(map);markers=L.layerGroup().addTo(map);targets=L.layerGroup().addTo(map);
 map.on('moveend',drawBoard);
 map.on('click',e=>{if(searching)return;const id=clickCount%2===0?'start':'end';if(clickCount%2===0){$('end').value='';clearAddress('end');}clearAddress(id);$(id).value=`${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;clickCount++;updateMarkers();});
 ['start','end'].forEach(id=>$(id).addEventListener('change',updateMarkers));
 try{
  const response=await fetch('/api/board');if(!response.ok)throw Error('Could not read local board.');
  const data=await response.json();board=data.coverage;
  const last=Math.max(...board.map(c=>c.last_report_ts||0));
  $('status').textContent=`${board.length.toLocaleString()} known squares loaded. Latest report: ${new Date(last*1000).toLocaleString()}. Zoom in to see territory colors.`;
  drawBoard();
 }catch(e){$('status').textContent=e.message;$('submit').disabled=true;}
}
function setSearching(active){
 searching=active;
 for(const id of ['start','end','start-lookup','end-lookup','budget','strategy','submit','print'])$(id).disabled=active;
 $('submit').textContent=active ? 'Searching routes…' : 'Find BLUE opportunities →';
 $('results').setAttribute('aria-busy',String(active));
 document.querySelectorAll('.address-options button, #comparison button').forEach(button=>button.disabled=active);
}
async function streamedPlan(payload, onProgress, signal){
 const response=await fetch('/api/plan-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});
 if(!response.ok){const data=await response.json();throw Error(data.error||'Route request failed.');}
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let buffer='',finalResult=null;
 while(true){
  const {value,done}=await reader.read();
  buffer+=decoder.decode(value,{stream:!done});
  const lines=buffer.split('\n');buffer=lines.pop();
  for(const line of lines){
   if(!line.trim())continue;
   const event=JSON.parse(line);
   if(event.type==='error')throw Error(event.error);
   if(event.type==='progress')onProgress(event);
   if(event.type==='result')finalResult=event;
  }
  if(done)break;
 }
 if(!finalResult)throw Error('The connection ended before the search finished. Please retry.');
 return finalResult;
}
$('planner').addEventListener('submit',async e=>{
 e.preventDefault();
 if(searching)return;
 let timer=null;
 try{
  searchController=new AbortController();setSearching(true);updateMarkers();
  $('search-progress').hidden=false;$('progress-bar').value=0;$('progress-percent').textContent='0%';
  $('progress-stage').textContent='Connecting to planner…';
  $('status').textContent='Search in progress. You can cancel at any time.';
  const started=Date.now();let lastUpdate=started;
  const updateTime=()=>{
   const seconds=Math.floor((Date.now()-started)/1000),quiet=Math.floor((Date.now()-lastUpdate)/1000);
   $('progress-time').textContent=`Elapsed ${Math.floor(seconds/60)}m ${seconds%60}s · Last update ${quiet}s ago${quiet>=10?' · Waiting for routing provider…':''}`;
  };
  updateTime();timer=setInterval(updateTime,1000);
  $('progress-stage').textContent='Checking start and destination…';
  const start=await resolveLocation('start',searchController.signal);
  const end=await resolveLocation('end',searchController.signal);
  if(!start || !end){
   $('status').textContent='Choose the matching addresses below the inputs, then find BLUE opportunities again.';
   $('progress-stage').textContent='Waiting for address selection';return;
  }
  updateMarkers();
  const requestedLabels={start:$('start').value,end:$('end').value};
  const data=await streamedPlan({start,end,detour_minutes:Number($('budget').value),strategy:$('strategy').value},event=>{
   lastUpdate=Date.now();$('progress-bar').value=event.percent;
   $('progress-percent').textContent=`${Math.floor(event.percent)}%`;
   $('progress-stage').textContent=event.message;updateTime();
  },searchController.signal);
  result=data;tripLabels=requestedLabels;
  $('progress-bar').value=100;$('progress-percent').textContent='100%';$('progress-stage').textContent='Search complete';
  showComparison();showActiveResult();
  $('status').textContent=`${data.strategy==='beam'?'Beam':'Greedy'}: ${data.routes.length} route options within budget. ${data.routing_metrics?.workers||1} routing workers; average request ${data.routing_metrics?.mean_request_seconds||0}s (including queue/rate-limit waits). ${data.failed_candidates ? `${data.failed_candidates} detour requests failed. ` : ''}Green outlines show targets; capture is not guaranteed.`;
 }catch(error){
  const cancelled=error.name==='AbortError';
  $('status').textContent=cancelled?'Search cancelled. You can change the settings and try again.':error.message;
  $('progress-stage').textContent=cancelled?'Search cancelled':'Search failed';
 }finally{
  if(timer)clearInterval(timer);
  searchController=null;setSearching(false);
 }
});
$('print').onclick=()=>window.print();
init();
