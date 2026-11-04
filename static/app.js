'use strict';
const $ = id => document.getElementById(id);
let board = [], result = null, routeIndex = 0, clickCount = 0;
let boardRevision=null,boardAvailable=false,feedMetadata=null,feedLoading=false;
const colors = {BLUE:'#1656e8',RED:'#e44444',GREEN:'#2e9e65',PURPLE:'#8858be',YELLOW:'#d2a716',ORANGE:'#e88032',PINK:'#db6aa5'};
let map, territories, routeLayer, markers, targets;
let searching = false, searchController = null;
const selectedLocations = {};
let tripLabels = null;
let waypointCounter=0,mapPickTarget=null;
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
 if(query.length<3)throw Error('Enter an address or latitude, longitude for each stop.');
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
function bindLocation(id){
 $(id).addEventListener('input',()=>{if(mapPickTarget===id)mapPickTarget=null;clearAddress(id);if(markers)updateMarkers();});
 $(id+'-lookup').onclick=async()=>{
  if(searching)return;
  if(mapPickTarget===id)mapPickTarget=null;
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
['start','end'].forEach(bindLocation);
function updateMarkers(){
 markers.clearLayers();
 for(const [id,label] of [['start','A'],...waypointIds().map((id,index)=>[id,`W${index+1}`]),['end','B']]){
  try{const p=locationPoint(id);L.marker([p[1],p[0]]).addTo(markers).bindTooltip(label,{permanent:true});}catch{}
 }
}
function waypointIds(){return [...document.querySelectorAll('#waypoints [data-waypoint]')].map(row=>row.dataset.waypoint);}
function refreshWaypointLabels(){
 const rows=[...document.querySelectorAll('#waypoints [data-waypoint]')];
 rows.forEach((row,index)=>{
  row.querySelector('label').textContent=`Waypoint W${index+1}`;
  row.querySelector('.waypoint-up').disabled=searching||index===0;
  row.querySelector('.waypoint-down').disabled=searching||index===rows.length-1;
  row.querySelector('.waypoint-map').setAttribute('aria-label',`Pick waypoint W${index+1} on map`);
  row.querySelector('.waypoint-remove').setAttribute('aria-label',`Remove waypoint W${index+1}`);
 });
 $('add-waypoint').disabled=searching||rows.length>=8;
 $('add-map-waypoint').disabled=searching||rows.length>=8;
 if(markers)updateMarkers();
}
function pickWaypoint(id){
 if(searching)return;
 mapPickTarget=id;
 const index=waypointIds().indexOf(id);
 $('status').textContent=`Click the map to set W${index+1}.`;
}
function addWaypoint(pickOnMap=false){
 if(searching||waypointIds().length>=8)return;
 const id=`waypoint-${++waypointCounter}`,row=document.createElement('div');
 row.className='waypoint-row';row.dataset.waypoint=id;
 row.innerHTML=`<label for="${id}"></label><input id="${id}" placeholder="Address or latitude, longitude" required autocomplete="off" aria-describedby="${id}-matches"><div class="waypoint-actions"><button id="${id}-lookup" class="lookup" type="button">Find address</button><button class="waypoint-map" type="button">Map</button><button class="waypoint-up" type="button" aria-label="Move waypoint up">↑</button><button class="waypoint-down" type="button" aria-label="Move waypoint down">↓</button><button class="waypoint-remove" type="button">Remove</button></div><div id="${id}-matches" class="address-options" aria-live="polite"></div>`;
 $('waypoints').append(row);bindLocation(id);
 row.querySelector('.waypoint-map').onclick=()=>pickWaypoint(id);
 row.querySelector('.waypoint-remove').onclick=()=>{
  if(searching)return;
  if(mapPickTarget===id)mapPickTarget=null;
  delete selectedLocations[id];row.remove();refreshWaypointLabels();
  $('status').textContent='Waypoint removed. Run a new search to update the route.';
 };
 row.querySelector('.waypoint-up').onclick=()=>{
  if(searching||!row.previousElementSibling)return;
  row.parentNode.insertBefore(row,row.previousElementSibling);refreshWaypointLabels();
  $('status').textContent='Waypoint order changed. Run a new search to update the route.';
 };
 row.querySelector('.waypoint-down').onclick=()=>{
  if(searching||!row.nextElementSibling)return;
  row.nextElementSibling.after(row);refreshWaypointLabels();
  $('status').textContent='Waypoint order changed. Run a new search to update the route.';
 };
 refreshWaypointLabels();
 if(pickOnMap)pickWaypoint(id);else $(id).focus();
}
$('add-waypoint').onclick=()=>addWaypoint();
$('add-map-waypoint').onclick=()=>addWaypoint(true);
document.addEventListener('keydown',event=>{
 if(event.key==='Escape' && mapPickTarget){mapPickTarget=null;$('status').textContent='Map waypoint selection cancelled.';}
});
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
let capturedUser='all';
try{capturedUser=localStorage.getItem('blue-captured-user')||'all';}catch{}
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
$('captured-by').addEventListener('change',event=>{
 capturedUser=event.target.value;
 try{localStorage.setItem('blue-captured-user',capturedUser);}catch{}
 updateSquareDarkness(true);
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
 const name=typeof cell?.captured_by==='string'?cell.captured_by.trim():'';
 if(capturedUser==='unknown' && name)return false;
 if(capturedUser.startsWith('user:') && `user:${name.toLowerCase()}`!==capturedUser)return false;
 if(captureDays===0)return true;
 const captured=cell?.captured_at;
 return typeof captured==='number' && Number.isFinite(captured) && captured>0 &&
        captured<=now && captured>=now-captureDays*86400;
}
function drawBoard(){
 if(!map)return;
 territories.clearLayers();
 if(!board.length){
  if(targets)targets.clearLayers();
  $('capture-filter-status').textContent='0 squares match.';return;
 }
 const bounds=map.getBounds();
 const now=Date.now()/1000;
 const eligible=board.filter(c=>captureVisible(c,now));
 $('capture-filter-status').textContent=`${eligible.length.toLocaleString()} of ${board.length.toLocaleString()} squares match the capture filters across all teams.${captureDays>0?' Missing or future capture times are hidden.':''}`;
 const visible=eligible.filter(c=>bounds.intersects([[c.south,c.west],[c.north,c.east]]));
 if(targets && result?.routes?.[routeIndex])drawRouteTargets(result.routes[routeIndex]);
 if(visible.length>2500){return;}
 for(const c of visible){
  const rect=L.rectangle([[c.south,c.west],[c.north,c.east]],squareStyle(c)).addTo(territories);
  rect.squareData=c;
  rect.on('mouseover',()=>rect.setStyle({stroke:true,color:colors[c.owner_team]||'#888888',weight:1,opacity:.75}));
  rect.on('mouseout',()=>rect.setStyle(squareStyle(c)));
  const captured=typeof c.captured_at==='number' && Number.isFinite(c.captured_at) && c.captured_at>0 ? ` · Captured ${new Date(c.captured_at*1000).toLocaleString()}` : '';
  rect.bindTooltip(`${escape(c.owner_team)} · ${escape(c.cell_id)} · ${scoreLabel(c)}${captured} · Captured by ${escape(c.captured_by||'Unknown')}`);
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
  if(step.maneuver.type==='arrive')text=legIndex===r.legs.length-1?'Arrive at destination B':`Reach ${r.stop_labels?.[legIndex]||'exploration detour'}; continue to the next leg`;
  steps.push(`<li><span>${escape(text)}</span><small>${miles(step.distance)}</small></li>`);
 }));
 $('results').innerHTML=`<div class="cards">${cards}</div><div class="routehead"><h2>Your driving directions</h2><div class="route-actions"><button id="phone-navigation" aria-expanded="false" aria-controls="navigation-handoff">Navigate / send to phone</button><button id="download">GeoJSON</button></div></div><div id="navigation-handoff" hidden></div><p class="trip">A: ${escape(tripLabels?.start||$('start').value)}${(tripLabels?.waypoints||[]).map((label,index)=>` → W${index+1}: ${escape(label)}`).join('')} → B: ${escape(tripLabels?.end||$('end').value)}<br>${minutes(r.duration)} · ${miles(r.distance)} · ${utility(r.capture_value)} weighted value<br>${r.easy_enemy_count} easy enemy · ${r.hard_enemy_count} defended enemy · ${r.unknown_score_count} unknown score<br>${r.enemy_count} enemy + ${r.unmapped_count} unpainted / ${r.square_count} squares crossed<br>Fastest baseline: ${minutes(base.duration)} · ${miles(base.distance)} · ${base.target_count} target squares · ${utility(base.capture_value)} weighted value</p><ol class="steps">${steps.join('')}</ol>`;
 document.querySelectorAll('[data-route]').forEach(el=>el.onclick=()=>showRoute(Number(el.dataset.route)));
 $('phone-navigation').onclick=()=>openNavigation(r);
 $('download').onclick=()=>{
  const blob=new Blob([JSON.stringify({type:'Feature',geometry:r.geometry,properties:{team:'BLUE',duration_seconds:r.duration,target_count:r.target_count,capture_value:r.capture_value,easy_enemy_count:r.easy_enemy_count,hard_enemy_count:r.hard_enemy_count,required_waypoints:result.required_waypoints}},null,2)],{type:'application/geo+json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='blue-route.geojson';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
}
function saveFile(blob,name){
 const url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function drawQr(container,url){
 if(typeof window.qrcode!=='function'){container.textContent='QR library unavailable. Copy the link instead.';return;}
 try{
  const code=window.qrcode(0,'M');code.addData(url);code.make();
  const count=code.getModuleCount(),scale=6,quiet=4,canvas=document.createElement('canvas');
  canvas.width=canvas.height=(count+quiet*2)*scale;
  canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Scan with your phone camera to open this Google Maps section');
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000';
  for(let row=0;row<count;row++)for(let col=0;col<count;col++)if(code.isDark(row,col))ctx.fillRect((col+quiet)*scale,(row+quiet)*scale,scale,scale);
  container.replaceChildren(canvas);
 }catch{container.textContent='Could not generate QR. Copy the link instead.';}
}
async function openNavigation(route){
 const panel=$('navigation-handoff'),button=$('phone-navigation');
 if(!panel.hidden){panel.hidden=true;button.setAttribute('aria-expanded','false');return;}
 panel.hidden=false;button.disabled=true;button.setAttribute('aria-expanded','true');
 panel.textContent='Preparing navigation links and GPX track…';
 try{
  const response=await fetch('/api/route-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({route:{geometry:route.geometry,via_points:route.via_points||[],stop_labels:route.stop_labels||[]}})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Export failed.');
  // A route switch may have removed this panel while export was being prepared.
  if(!panel.isConnected)return;
  panel.innerHTML=`<h3>Take this drive on your phone</h3><p>Scan a QR code with your phone camera to open Google Maps. No email or access to this local app is needed. For longer routes, copy/share all section links to your phone before leaving, then finish each section and open the next one.</p><p class="handoff-note">Google Maps recalculates roads between the stops and may skip capture streets. Check its preview before starting. GPX preserves the complete planned track for a compatible track-following app; it does not contain spoken instructions.</p><div class="route-actions"><button id="navigation-copy-all">Copy all navigation links</button><button id="navigation-share-all" hidden>Share all links</button></div><div class="route-actions handoff-file-actions"><button id="gpx-download">Download GPX track</button><button id="gpx-share" hidden>Share GPX file</button></div><p class="fine">Transfer the GPX file using AirDrop, Quick Share, your files/cloud app, or email. Import it in a navigation app that supports following GPX tracks. ${data.trackpoint_count.toLocaleString()} track points retained.</p><div id="navigation-sections"></div><p id="handoff-status" role="status" aria-live="polite"></p>`;
  const allLinks=data.sections.map((section,index)=>`Section ${index+1}/${data.sections.length}: ${section.from_label} → ${section.to_label}\n${section.url}`).join('\n\n');
  const allLinksText=`MeshWars BLUE drive — Google may recalculate roads. Open sections in order.\n\n${allLinks}`;
  panel.querySelector('#navigation-copy-all').onclick=async()=>{
   try{await navigator.clipboard.writeText(allLinksText);panel.querySelector('#handoff-status').textContent='All navigation links copied. Paste them into your preferred phone transfer app.';}
   catch{const text=document.createElement('textarea');text.value=allLinksText;text.setAttribute('aria-label','All navigation links');panel.append(text);text.focus();text.select();panel.querySelector('#handoff-status').textContent='Links selected. Copy them with your keyboard or browser menu.';}
  };
  if(navigator.share){const button=panel.querySelector('#navigation-share-all');button.hidden=false;button.onclick=async()=>{
   try{await navigator.share({title:'MeshWars BLUE navigation sections',text:allLinksText});}
   catch(error){if(error.name!=='AbortError')panel.querySelector('#handoff-status').textContent='Sharing unavailable. Use Copy all navigation links.';}
  };}
  const file=new File([data.gpx],'blue-route.gpx',{type:'application/gpx+xml'});
  panel.querySelector('#gpx-download').onclick=()=>saveFile(file,'blue-route.gpx');
  const shareFile=panel.querySelector('#gpx-share');
  if(navigator.share && navigator.canShare?.({files:[file]})){
   shareFile.hidden=false;
   shareFile.onclick=async()=>{try{await navigator.share({files:[file],title:'MeshWars BLUE route'});}catch(error){if(error.name!=='AbortError')panel.querySelector('#handoff-status').textContent='File sharing unavailable. Download GPX and transfer it manually.';}};
  }
  for(const [index,section] of data.sections.entries()){
   const card=document.createElement('section');card.className='navigation-section';
   card.innerHTML=`<h4>Section ${index+1} of ${data.sections.length}: ${escape(section.from_label)} → ${escape(section.to_label)}</h4><p class="fine">${section.labels.map(escape).join(' → ')}</p><div class="navigation-qr"></div><div class="route-actions"><a class="navigation-open" target="_blank" rel="noopener noreferrer">Open Google Maps</a><button class="navigation-copy">Copy link</button><button class="navigation-share" hidden>Share link</button></div><input class="navigation-url" readonly aria-label="Google Maps section ${index+1} link">`;
   const input=card.querySelector('input');input.value=section.url;input.onclick=()=>input.select();
   card.querySelector('a').href=section.url;
   drawQr(card.querySelector('.navigation-qr'),section.url);
   card.querySelector('.navigation-copy').onclick=async()=>{
    try{await navigator.clipboard.writeText(section.url);panel.querySelector('#handoff-status').textContent=`Section ${index+1} link copied.`;}
    catch{input.focus();input.select();panel.querySelector('#handoff-status').textContent='Link selected. Copy it with your keyboard or browser menu.';}
   };
   const share=card.querySelector('.navigation-share');
   if(navigator.share){share.hidden=false;share.onclick=async()=>{try{await navigator.share({title:`BLUE route — section ${index+1}`,url:section.url});}catch(error){if(error.name!=='AbortError')panel.querySelector('#handoff-status').textContent='Sharing unavailable. Use Copy link or scan the QR code.';}};}
   panel.querySelector('#navigation-sections').append(card);
  }
 }catch(error){panel.textContent=error.message;}
 finally{if(button.isConnected)button.disabled=false;}
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
function updateCapturedUsers(){
 const options=new Map();
 for(const cell of board){
  if(typeof cell.captured_by!=='string'||!cell.captured_by.trim())continue;
  const name=cell.captured_by.trim(),key=`user:${name.toLowerCase()}`;
  const entry=options.get(key)||{name,count:0};entry.count++;options.set(key,entry);
 }
 const select=$('captured-by');select.replaceChildren();
 const add=(value,label)=>{const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);};
 add('all','All players');add('unknown','Unknown / unattributed');
 for(const [key,entry] of [...options].sort((a,b)=>a[1].name.localeCompare(b[1].name)))add(key,`${entry.name} (${entry.count})`);
 if(capturedUser.startsWith('user:')&&!options.has(capturedUser))add(capturedUser,`${capturedUser.slice(5)} (no attributed squares)`);
 select.value=capturedUser;
 if(!select.value){capturedUser='all';select.value='all';}
 const attribution=feedMetadata?.attribution;
 select.disabled=options.size===0 && capturedUser==='all';
 $('captured-by-help').textContent=!attribution?.configured && options.size===0
  ?'No player names in the board feed. Configure MESHWARS_API_KEY on the server to enable capture attribution.'
  :`${options.size} players identified in current squares. Recent observed events only; unmatched squares stay Unknown. Filters combine with capture age. ${attribution?.error||''}`;
}
function renderFeedStatus(){
 if(!feedMetadata)return;
 const meta=feedMetadata;
 const stamp=value=>value?new Date(value*1000).toLocaleString():'not yet';
 const state=meta.refreshing?'Refreshing MeshWars…':meta.stale?'Using fallback data':'Live feed';
 $('board-feed-status').textContent=`${state} · ${meta.coverage_count.toLocaleString()} squares. Last successful check: ${stamp(meta.last_success)}. Last attempt: ${stamp(meta.last_checked)}. Automatic check interval: ${meta.error?meta.retry_interval:meta.refresh_interval}s. ${meta.error||meta.cache_error||''}`;
 document.querySelector('.board-feed').dataset.stale=String(meta.stale);
 updateCapturedUsers();
 $('board-route-warning').hidden=!(result && result.board_revision && result.board_revision!==boardRevision);
}
async function refreshBoard(full=false){
 if(feedLoading)return;
 feedLoading=true;
 try{
  let response=await fetch(full?'/api/board':'/api/board/status',{cache:'no-store'});
  if(!response.ok)throw Error('Local board feed unavailable. Retrying automatically.');
  let data=await response.json();
  if(data.available && !Object.hasOwn(data,'coverage') && data.revision!==boardRevision){
   response=await fetch('/api/board',{cache:'no-store'});
   if(!response.ok)throw Error('Could not load the updated board. Retrying automatically.');
   data=await response.json();
  }
  feedMetadata=data;
  if(data.available && Array.isArray(data.coverage)){
   board=data.coverage;boardRevision=data.revision;boardAvailable=true;
   updateCapturedUsers();drawBoard();
  }
  renderFeedStatus();
  if(!searching)$('submit').disabled=!boardAvailable;
 }catch(error){
  $('board-feed-status').textContent=`${error.message} ${boardAvailable?'The last loaded board remains available.':''}`;
  document.querySelector('.board-feed').dataset.stale='true';
 }finally{feedLoading=false;}
}
$('refresh-board').onclick=async()=>{
 $('refresh-board').disabled=true;
 try{
  const response=await fetch('/api/board/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  if(!response.ok)throw Error('Could not request a refresh. Automatic checks will continue.');
  $('board-feed-status').textContent='Refresh requested. Checking for updates…';
  setTimeout(()=>refreshBoard(),1500);
 }catch(error){$('board-feed-status').textContent=error.message;}
 finally{setTimeout(()=>{$('refresh-board').disabled=false;},15000);}
};
async function init(){
 if(!window.L){$('status').textContent='Map library could not load. Check access to unpkg.com and reload.';$('submit').disabled=true;return;}
 map=L.map('map',{preferCanvas:true}).setView([40.6,-111.9],10);
 const progressControl=L.control({position:'topright'});
 progressControl.onAdd=()=>{
  const panel=$('search-progress');
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);
  return panel;
 };
 progressControl.addTo(map);
 const sizeProgressPanel=()=>{$('search-progress').style.maxHeight=`${Math.max(80,map.getSize().y-20)}px`;};
 map.on('resize',sizeProgressPanel);
 sizeProgressPanel();
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
 initPanelResize();
 territories=L.layerGroup().addTo(map);routeLayer=L.layerGroup().addTo(map);markers=L.layerGroup().addTo(map);targets=L.layerGroup().addTo(map);
 map.on('moveend',drawBoard);
 map.on('click',e=>{
  if(searching)return;
  if(mapPickTarget){
   const id=mapPickTarget;mapPickTarget=null;
   clearAddress(id);$(id).value=`${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
   updateMarkers();$('status').textContent='Waypoint set. Add more stops or find BLUE opportunities.';return;
  }
  const id=clickCount%2===0?'start':'end';
  if(clickCount%2===0){$('end').value='';clearAddress('end');}
  clearAddress(id);$(id).value=`${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
  clickCount++;updateMarkers();
 });
 ['start','end'].forEach(id=>$(id).addEventListener('change',updateMarkers));
 $('submit').disabled=true;
 await refreshBoard(true);
 $('status').textContent=boardAvailable?'Choose start and destination to plan a drive.':'Waiting for capture data; automatic checks will continue.';
 setInterval(()=>refreshBoard(),30*60*1000);
}
function setSearching(active){
 searching=active;
 const progress=$('search-progress');
 if(active){progress.dataset.meshState='searching';progress.querySelector('.mesh-caption').textContent='Exploring the mesh';}
 else{
  const complete=$('progress-bar').value===100;
  progress.dataset.meshState=complete?'complete':'idle';
  progress.querySelector('.mesh-caption').textContent=complete?'Route search complete':'Mesh standing by';
 }
 for(const id of ['start','end','start-lookup','end-lookup','budget','strategy','submit','print'])$(id).disabled=active;
 $('submit').textContent=active ? 'Searching routes…' : 'Find BLUE opportunities →';
 $('submit').disabled=active||!boardAvailable;
 $('results').setAttribute('aria-busy',String(active));
 document.querySelectorAll('.address-options button, #comparison button, #waypoints input, #waypoints button').forEach(button=>button.disabled=active);
 refreshWaypointLabels();
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
  const requiredWaypoints=[];
  for(const id of waypointIds())requiredWaypoints.push(await resolveLocation(id,searchController.signal));
  const end=await resolveLocation('end',searchController.signal);
  if(!start || !end || requiredWaypoints.some(point=>!point)){
   $('status').textContent='Choose the matching addresses below the inputs, then find BLUE opportunities again.';
   $('progress-stage').textContent='Waiting for address selection';return;
  }
  updateMarkers();
  const requestedLabels={start:$('start').value,end:$('end').value,waypoints:waypointIds().map(id=>$(id).value)};
  const data=await streamedPlan({start,end,waypoints:requiredWaypoints,detour_minutes:Number($('budget').value),strategy:$('strategy').value},event=>{
   lastUpdate=Date.now();$('progress-bar').value=event.percent;
   $('progress-percent').textContent=`${Math.floor(event.percent)}%`;
   $('progress-stage').textContent=event.message;updateTime();
  },searchController.signal);
  result=data;tripLabels=requestedLabels;renderFeedStatus();
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
