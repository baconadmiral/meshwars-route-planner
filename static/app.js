'use strict';
const $ = id => document.getElementById(id);
let board = [], result = null, routeIndex = 0, clickCount = 0;
const colors = {BLUE:'#1656e8',RED:'#e44444',GREEN:'#2e9e65',PURPLE:'#8858be',YELLOW:'#d2a716',ORANGE:'#e88032',PINK:'#db6aa5'};
let map, territories, routeLayer, markers, targets;
let searching = false, searchController = null;
const selectedLocations = {};
let tripLabels = null;
$('cancel-search').onclick = () => searchController?.abort();
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
function drawBoard(){
 if(!map || !board.length)return;
 territories.clearLayers();
 const bounds=map.getBounds();
 const visible=board.filter(c=>bounds.intersects([[c.south,c.west],[c.north,c.east]]));
 if(visible.length>2500){return;}
 for(const c of visible){
  const rect=L.rectangle([[c.south,c.west],[c.north,c.east]],{color:colors[c.owner_team]||'#888',weight:.7,fillOpacity:c.owner_team==='BLUE'?.13:.25}).addTo(territories);
  rect.bindTooltip(`${escape(c.owner_team)} · ${escape(c.cell_id)}`);
 }
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
function showRoute(index){
 routeIndex=index;
 const r=result.routes[index], base=result.baseline;
 routeLayer.clearLayers();
 targets.clearLayers();
 const known = new Map(board.map(c=>[c.cell_id,c]));
 for(const id of r.target_ids){
  const cell=known.get(id);
  const [row,col]=id.split('_').map(Number);
  const bounds=cell ? [[cell.south,cell.west],[cell.north,cell.east]] : [[row*.0027,col*.00384],[(row+1)*.0027,(col+1)*.00384]];
  L.rectangle(bounds,{color:'#15966c',weight:2,dashArray:cell?null:'4 4',fillOpacity:.18}).addTo(targets).bindTooltip(cell?`Enemy target · ${escape(cell.owner_team)}`:'Unpainted exploration · coverage unknown');
 }
 L.geoJSON(base.geometry,{style:{color:'#8494aa',weight:5,opacity:.55}}).addTo(routeLayer);
 const line=L.geoJSON(r.geometry,{style:{color:'#1656e8',weight:5,opacity:.95}}).addTo(routeLayer);
 map.fitBounds(line.getBounds(),{padding:[25,25]});
 const cards=result.routes.map((v,i)=>`<button class="card ${i===index?'selected':''}" data-route="${i}" aria-pressed="${i===index}">${i===0?'Best BLUE opportunity':`Alternative ${i+1}`}<b>${v.target_count} target squares</b><small>${v.enemy_count} enemy · ${v.unmapped_count} unpainted<br>${minutes(v.duration)} · ${miles(v.distance)}<br>+${minutes(Math.max(0,v.duration-base.duration))} vs fastest</small></button>`).join('');
 const steps=[];
 r.legs.forEach((leg,legIndex)=>leg.steps.forEach(step=>{
  let text=instruction(step);
  if(step.maneuver.type==='arrive')text=legIndex===r.legs.length-1?'Arrive at destination B':'Reach detour waypoint; continue to the next leg';
  steps.push(`<li><span>${escape(text)}</span><small>${miles(step.distance)}</small></li>`);
 }));
 $('results').innerHTML=`<div class="cards">${cards}</div><div class="routehead"><h2>Your driving directions</h2><button id="download">Download route GeoJSON</button></div><p class="trip">A: ${escape(tripLabels?.start||$('start').value)} → B: ${escape(tripLabels?.end||$('end').value)}<br>${minutes(r.duration)} · ${miles(r.distance)} · ${r.enemy_count} enemy + ${r.unmapped_count} unpainted / ${r.square_count} squares crossed<br>Fastest baseline: ${minutes(base.duration)} · ${miles(base.distance)} · ${base.target_count} target squares</p><ol class="steps">${steps.join('')}</ol>`;
 document.querySelectorAll('[data-route]').forEach(el=>el.onclick=()=>showRoute(Number(el.dataset.route)));
 $('download').onclick=()=>{
  const blob=new Blob([JSON.stringify({type:'Feature',geometry:r.geometry,properties:{team:'BLUE',duration_seconds:r.duration,target_count:r.target_count}},null,2)],{type:'application/geo+json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='blue-route.geojson';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
}
async function init(){
 if(!window.L){$('status').textContent='Map library could not load. Check access to unpkg.com and reload.';$('submit').disabled=true;return;}
 map=L.map('map',{preferCanvas:true}).setView([40.6,-111.9],10);
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
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
 for(const id of ['start','end','start-lookup','end-lookup','budget','submit','print'])$(id).disabled=active;
 $('submit').textContent=active ? 'Searching routes…' : 'Find BLUE opportunities →';
 $('results').setAttribute('aria-busy',String(active));
 document.querySelectorAll('.address-options button').forEach(button=>button.disabled=active);
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
  const data=await streamedPlan({start,end,detour_minutes:Number($('budget').value)},event=>{
   lastUpdate=Date.now();$('progress-bar').value=event.percent;
   $('progress-percent').textContent=`${Math.floor(event.percent)}%`;
   $('progress-stage').textContent=event.message;updateTime();
  },searchController.signal);
  result=data;tripLabels=requestedLabels;
  $('progress-bar').value=100;$('progress-percent').textContent='100%';$('progress-stage').textContent='Search complete';
  if(data.no_opportunities){
   routeLayer.clearLayers();targets.clearLayers();
   $('results').innerHTML=`<div class="empty"><h2>No useful route found</h2><p>${escape(data.message)}</p><p>The fastest route crosses zero target squares. Try a larger detour budget.</p></div>`;
   $('status').textContent=data.message;return;
  }
  showRoute(0);$('status').textContent=`${data.routes.length} route options within budget. ${data.failed_candidates ? `${data.failed_candidates} detour requests failed. ` : ''}Dashed green squares are unpainted exploration targets; coverage is unknown. Capture is not guaranteed.`;
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
