'use strict';
const $ = id => document.getElementById(id);
function startupState(update){
 window.appStartupState={...(window.appStartupState||{}),...update};
 window.dispatchEvent(new Event('app-startup'));
}
$('open-reports').onclick=()=>{window.location.href='/reports';};
async function loadAppVersion(){
 const label=$('app-version');
 try{
  const response=await fetch('/api/version',{cache:'no-store'});
  if(!response.ok)throw Error('Version unavailable');
  const data=await response.json();
  if(!data||!(data.version==='development'||/^[0-9a-f]{12}$/.test(data.version)))throw Error('Invalid version');
  label.textContent=`Version ${data.version}`;
  label.setAttribute('aria-label',`Version ${data.version}; recent changes`);
  const changes=Array.isArray(data.changes)?data.changes.filter(item=>typeof item==='string').slice(0,5):[];
  const revision=data.revision?`Deployed Git commit: ${data.revision}`:'Local development build; no production commit was embedded.';
  label.title=revision+(changes.length?'\n\nRecent changes:\n'+changes.map(change=>'• '+change).join('\n'):'\nNo recent change notes are embedded in this build.');
  $('version-revision').textContent=revision;
  $('version-changes').replaceChildren(...changes.map(change=>{const item=document.createElement('li');item.textContent=change;return item;}));
  $('version-empty').hidden=changes.length>0;
  label.disabled=false;
 }catch{
  label.textContent='Version unavailable';
  label.title='Refresh to retry loading the deployed version.';
 }
}
loadAppVersion();
$('app-version').onclick=()=>$('version-dialog').showModal();
$('version-close').onclick=()=>$('version-dialog').close();

let board = [], result = null, routeIndex = 0;
let boardRevision=null,boardAvailable=false,feedMetadata=null,feedLoading=false,boardStartupChecks=0;
const colors = {BLUE:'#1656e8',RED:'#e44444',GREEN:'#2e9e65',PURPLE:'#8858be',YELLOW:'#d2a716',ORANGE:'#e88032',PINK:'#db6aa5'};
const routeColors={BLUE:'#ffd43b',RED:'#00d4e8',GREEN:'#ff3ca0',PURPLE:'#ffd43b',YELLOW:'#ff3ca0',ORANGE:'#00d4e8',PINK:'#00d4e8'};
const routeColor=team=>routeColors[team]||'#ffd43b';
const selectedTeam=()=>$('team').value;
let map, territories, routeLayer, markers, targets, radioLayer, bonusPlacesLayer;
window.addEventListener('app-visible',()=>{
 if(map){map.invalidateSize({pan:false});window.dispatchEvent(new Event('resize'));}
});
let excludedPlaceIds=new Set(),placeScoringWeek=null;
let radioSnapshot=null,radioStartupChecks=0;
const meshSquareEvidence=new Map();
let mapTeamFilter=null,capturedSquaresHidden=false;
let mapPlayerFilter='',playerRoster=null;
let squareLookupTimer=null,squareLookupBusy=false,squareLookupMoving=false,squareLookupPauseUntil=0,squareLookupError='';
const automaticSquareRefreshEnabled=false;
let squareLookupMinZoom=15;
const squareLookupFreshMs=5*60*1000;
try{const saved=Number(localStorage.getItem('square-detail-min-zoom'));if(Number.isInteger(saved)&&saved>=13&&saved<=19)squareLookupMinZoom=saved;}catch{}
const squareLookupChecks=new Map();
const refreshingSquares=new Map();
let squareRefreshLayers=null,squareRefreshRenderer=null;
const squareVersion=cell=>`${cell.cell_id}:${cell.owner_team}:${cell.captured_at??''}`;
try{capturedSquaresHidden=localStorage.getItem('hide-captured-squares')==='true';}catch{}
let searching = false, searchController = null, planningRoute = false, progressMinimized = false;
const selectedLocations = {};
let addressPreview=null;
let tripLabels = null;
let waypointCounter=0,mapPickTarget=null;
let suppressMapPickUntil=0;
let allowedBounds=null,areaDrawing=null,areaLayer=null,areaPreview=null;
let blockedRoads=[],blockedRoadDrawing=null,blockedRoadLayer=null,blockedRoadPreview=null;
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
function clearAddressPreview(button=null){
 if(!addressPreview||(button&&addressPreview.button!==button))return;
 addressPreview.marker.remove();addressPreview=null;
}
function previewAddress(match,button,id){
 if(!map||button.disabled)return;
 clearAddressPreview();
 const point=[match.coordinates[1],match.coordinates[0]];
 const label=document.createElement('span');label.textContent=`Preview: ${match.label}`;
 const marker=L.marker(point,{interactive:false,keyboard:false,zIndexOffset:1000,opacity:.85})
  .addTo(map).bindTooltip(label,{permanent:true,direction:'top',offset:[0,-35],className:'address-preview-tooltip'});
 addressPreview={marker,button,id};
 map.stop();
 if(map.getZoom()<15)map.setView(point,16,{animate:false});
 else if(!map.getBounds().pad(-.15).contains(point))map.panTo(point,{animate:false});
}
function clearAddress(id){
 if(addressPreview?.id===id)clearAddressPreview();
 delete selectedLocations[id];$(id+'-matches').replaceChildren();
}
async function resolveLocation(id,signal){
 try{return locationPoint(id);}catch(error){
  // Numeric coordinate pairs with invalid ranges should remain validation errors.
  if(/^\s*[+-]?[\d.]+\s*,\s*[+-]?[\d.]+\s*$/.test($(id).value))throw error;
 }
 const query=$(id).value.trim();
 if(query.length<3)throw Error('Enter an address or latitude, longitude for each stop.');
 if(addressPreview?.id===id)clearAddressPreview();
 const choices=$(id+'-matches');choices.textContent='Looking up address…';
 const response=await fetch('/api/geocode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query}),signal});
 const data=await response.json();
 if(!response.ok){choices.textContent=data.error;throw Error(data.error||'Address lookup failed.');}
 choices.replaceChildren();
 if(!data.results.length){choices.textContent='No matches. Add city, state, or ZIP code, or use coordinates.';return null;}
 const title=document.createElement('p');title.textContent='Hover or focus a result to preview its pin, then select it. Check road access before choosing:';choices.append(title);
 for(const match of data.results){
  const button=document.createElement('button');button.type='button';button.textContent=match.label;
  button.addEventListener('pointerenter',()=>previewAddress(match,button,id));
  button.addEventListener('focus',()=>previewAddress(match,button,id));
  button.addEventListener('pointerleave',()=>{if(document.activeElement!==button)clearAddressPreview(button);});
  button.addEventListener('blur',()=>{if(!button.matches(':hover'))clearAddressPreview(button);});
  button.onclick=()=>{
   clearAddressPreview();
   $(id).value=match.label;selectedLocations[id]=match;
   choices.textContent=`Selected: ${match.coordinates[1].toFixed(6)}, ${match.coordinates[0].toFixed(6)}`;
   updateMarkers();map.panTo([match.coordinates[1],match.coordinates[0]]);
   $('status').textContent=`Location selected. Confirm the other endpoint, then find ${selectedTeam()} opportunities.`;
  };
  choices.append(button);
 }
 return null;
}
function bindLocation(id){
 $(id).addEventListener('input',()=>{
  const wasSelecting=!!mapPickTarget;
  setMapPickTarget(null);clearAddress(id);if(markers)updateMarkers();
  if(wasSelecting)$('status').textContent='Map selection stopped. Enter a location, or select Map to pick a stop.';
 });
 if(id==='start'||id==='end'){
  $(id).addEventListener('click',()=>pickEndpoint(id));
  $(id+'-map').onclick=()=>pickEndpoint(id,true);
 }
 $(id+'-lookup').onclick=async()=>{
  if(searching)return;
  setMapPickTarget(null);
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
$('swap-endpoints').onclick=()=>{
 if(searching)return;
 const startValue=$('start').value,endValue=$('end').value;
 const startLocation=selectedLocations.start,endLocation=selectedLocations.end;
 clearAddress('start');clearAddress('end');
 $('start').value=endValue;$('end').value=startValue;
 if(endLocation&&endLocation.label===endValue.trim())selectedLocations.start=endLocation;
 if(startLocation&&startLocation.label===startValue.trim())selectedLocations.end=startLocation;
 setMapPickTarget(null);
 clearDisplayedRoute();
 if(markers)updateMarkers();
 $('status').textContent='Start and finish swapped. Plan again to find routes.';
};

function updateMarkers(){
 markers.clearLayers();
 for(const [id,label] of [['start','Start'],...waypointIds().map((id,index)=>[id,`W${index+1}`]),['end','Finish']]){
  try{const p=locationPoint(id);L.marker([p[1],p[0]]).addTo(markers).bindTooltip(label,{permanent:true});}catch{}
 }
}
function waypointIds(){return [...document.querySelectorAll('#waypoints [data-waypoint]')].map(row=>row.dataset.waypoint);}
function setMapPickTarget(id){
 mapPickTarget=id;
 if(id)suppressMapPickUntil=0;
 for(const endpoint of ['start','end']){
  $(endpoint).classList.toggle('map-pick-active',id===endpoint);
  $(endpoint+'-map').setAttribute('aria-pressed',String(id===endpoint));
 }
 $('map-pick-banner').hidden=!id;
 $('map').classList.toggle('map-picking',!!id);
 if(id){
  const name=id==='start'?'Start':id==='end'?'Finish':`W${waypointIds().indexOf(id)+1}`;
  $('map-pick-message').textContent=`Tap the map to set ${name}.${id==='start'?' Then tap again to set Finish.':''} Dragging or scrolling will not place a stop.`;
 }
 document.querySelector('.workspace').dispatchEvent(new Event('routepanelchange'));
}
function pickEndpoint(id,scroll=false){
 if(searching)return;
 cancelAreaDrawing();cancelBlockedRoadDrawing();clearAddressPreview();
 setMapPickTarget(id);
 $('status').textContent=$('map-pick-message').textContent;
 if(scroll){document.querySelector('.workspace').scrollIntoView({block:'start',behavior:'auto'});$('map').focus({preventScroll:true});}
}
$('cancel-map-pick').onclick=()=>{setMapPickTarget(null);$('status').textContent='Map selection cancelled. Your stops are unchanged.';};
function guardMapGestures(){
 const pointers=new Map(),element=$('map');
 const suppress=()=>{suppressMapPickUntil=Date.now()+500;};
 element.addEventListener('pointerdown',event=>{
  if(!pointers.size)suppressMapPickUntil=0;
  pointers.set(event.pointerId,{x:event.clientX,y:event.clientY,moved:false});
  if(pointers.size>1){for(const point of pointers.values())point.moved=true;suppress();}
 },{capture:true,passive:true});
 window.addEventListener('pointermove',event=>{
  const point=pointers.get(event.pointerId);if(!point)return;
  if(Math.hypot(event.clientX-point.x,event.clientY-point.y)>8){point.moved=true;suppress();}
 },{capture:true,passive:true});
 const end=event=>{
  const point=pointers.get(event.pointerId);
  if(point&&(point.moved||event.type==='pointercancel'))suppress();
  pointers.delete(event.pointerId);
 };
 window.addEventListener('pointerup',end,{capture:true,passive:true});
 window.addEventListener('pointercancel',end,{capture:true,passive:true});
 window.addEventListener('blur',()=>{if(pointers.size)suppress();pointers.clear();});
 element.addEventListener('wheel',suppress,{capture:true,passive:true});
}
function revealSidebarControl(control){
 for(let parent=control?.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
}
document.querySelectorAll('[data-sidebar-target]').forEach(button=>button.onclick=()=>{
 const target=$(button.dataset.sidebarTarget);
 if(target.tagName==='DETAILS')target.open=true;
 revealSidebarControl(target);target.scrollIntoView({behavior:'smooth',block:'start'});
});
$('planner').addEventListener('invalid',event=>revealSidebarControl(event.target),true);
function refreshWaypointLabels(){
 const rows=[...document.querySelectorAll('#waypoints [data-waypoint]')];
 $('waypoint-options').querySelector('summary').firstChild.textContent=rows.length?`Waypoints · ${rows.length} stops`:'Waypoints';
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
 cancelAreaDrawing();cancelBlockedRoadDrawing();
 if(searching)return;
 setMapPickTarget(id);
 const index=waypointIds().indexOf(id);
 $('status').textContent=`Click the map to set W${index+1}.`;
}
function addWaypoint(pickOnMap=false){
 if(searching||waypointIds().length>=8)return;
 $('waypoint-options').open=true;
 const id=`waypoint-${++waypointCounter}`,row=document.createElement('div');
 row.className='waypoint-row';row.dataset.waypoint=id;
 row.innerHTML=`<label for="${id}"></label><input id="${id}" placeholder="Address or latitude, longitude" required autocomplete="off" aria-describedby="${id}-matches"><div class="waypoint-actions"><button id="${id}-lookup" class="lookup" type="button">Find address</button><button class="waypoint-map" type="button">Map</button><button class="waypoint-up" type="button" aria-label="Move waypoint up">↑</button><button class="waypoint-down" type="button" aria-label="Move waypoint down">↓</button><button class="waypoint-remove" type="button">Remove</button></div><div id="${id}-matches" class="address-options" aria-live="polite"></div>`;
 $('waypoints').append(row);bindLocation(id);
 row.querySelector('.waypoint-map').onclick=()=>pickWaypoint(id);
 row.querySelector('.waypoint-remove').onclick=()=>{
  if(searching)return;
  if(mapPickTarget===id)setMapPickTarget(null);
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
 if(event.key==='Escape' && mapPickTarget){setMapPickTarget(null);$('status').textContent='Map selection cancelled. Your stops are unchanged.';}
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
  const style=squareStyle({owner_team:selectedTeam(),scores:{[selectedTeam()]:points}});
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
 if(capturedSquaresHidden&&cell)return false;
 if(mapPlayerFilter&&!cell)return false;
 if(mapPlayerFilter==='__unknown__'&&cell?.captured_by)return false;
 if(mapPlayerFilter&&mapPlayerFilter!=='__unknown__'&&cell?.captured_by?.toLocaleLowerCase()!==mapPlayerFilter.toLocaleLowerCase())return false;
 if(mapTeamFilter&&cell?.owner_team!==mapTeamFilter)return false;
 return captureAgeVisible(cell,now);
}
function captureAgeVisible(cell,now=Date.now()/1000){
 if(captureDays===0)return true;
 const captured=cell?.captured_at;
 return typeof captured==='number' && Number.isFinite(captured) && captured>0 &&
        captured<=now && captured>=now-captureDays*86400;
}
// Spatial buckets bound comparisons while retaining proximity across date lines/poles.
function rankCaptureAreas(cells){
 const radius=3000,earth=6371000,buckets=new Map(),points=[],parents=[];
 function root(i){while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;}
 for(const cell of cells){
  if(![cell.south,cell.north,cell.west,cell.east].every(Number.isFinite)||cell.south>cell.north||cell.west>cell.east)continue;
  const lat=(cell.south+cell.north)/2*Math.PI/180,lon=(cell.west+cell.east)/2*Math.PI/180;
  if(Math.abs(lat)>Math.PI/2||Math.abs(lon)>Math.PI)continue;
  const xyz=[earth*Math.cos(lat)*Math.cos(lon),earth*Math.cos(lat)*Math.sin(lon),earth*Math.sin(lat)];
  const bin=xyz.map(v=>Math.floor(v/radius)),i=points.length;
  points.push({cell,xyz});parents.push(i);
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++){
   for(const j of buckets.get(`${bin[0]+dx},${bin[1]+dy},${bin[2]+dz}`)||[]){
    const other=points[j].xyz;
    if(xyz.reduce((sum,v,k)=>sum+(v-other[k])**2,0)<=radius**2){const a=root(i),b=root(j);if(a!==b)parents[a]=b;}
   }
  }
  const key=bin.join(',');if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(i);
 }
 const groups=new Map();
 points.forEach(({cell},i)=>{const key=root(i);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(cell);});
 return [...groups.values()].map(group=>{
  const origin=(group[0].west+group[0].east)/2;
  let south=90,north=-90,west=Infinity,east=-Infinity,newest=0;
  for(const cell of group){
   const center=(cell.west+cell.east)/2,shift=Math.round((origin-center)/360)*360;
   south=Math.min(south,cell.south);north=Math.max(north,cell.north);west=Math.min(west,cell.west+shift);east=Math.max(east,cell.east+shift);
   if(Number.isFinite(cell.captured_at)&&cell.captured_at<=Date.now()/1000)newest=Math.max(newest,cell.captured_at);
  }
  return {count:group.length,newest,bounds:[[south,west],[north,east]],key:group.map(c=>String(c.cell_id)).sort()[0]};
 }).sort((a,b)=>b.count-a.count||b.newest-a.newest||a.key.localeCompare(b.key));
}
let captureAreas=[],captureAreaIndex=-1,captureAreaFingerprint=null;
function captureAreaCells(){const now=Date.now()/1000;return board.filter(c=>captureVisible(c,now));}
function captureAreaKey(cells){return `${mapTeamFilter}|${mapPlayerFilter}|${captureDays}|${capturedSquaresHidden}|`+cells.map(c=>`${squareVersion(c)}:${c.west},${c.south},${c.east},${c.north}`).join(';');}
function updateCaptureAreaControls(cells){
 if(captureAreaFingerprint!==null&&captureAreaFingerprint!==captureAreaKey(cells)){
  captureAreas=[];captureAreaIndex=-1;captureAreaFingerprint=null;
  $('capture-area-status').textContent='Filters or capture data changed. Find capture areas again.';
 }
 $('next-capture-area').disabled=captureAreas.length<2;
}
function fitCaptureBounds(bounds){
 // Mobile filters live above the map; bring the map into view after choosing an area.
 ($('map-filters').hidden?$('map'):$('map-filters')).scrollIntoView({block:'start',behavior:'auto'});map.invalidateSize({pan:false});
 map.fitBounds(bounds,{padding:[32,32],maxZoom:14,animate:false});
}
function showCaptureArea(){
 const area=captureAreas[captureAreaIndex];if(!area)return;
 const newest=area.newest?` · newest ${new Date(area.newest*1000).toLocaleDateString()}`:'';
 $('capture-area-status').textContent=`Area ${captureAreaIndex+1} of ${captureAreas.length} · ${area.count.toLocaleString()} matching ${mapTeamFilter||'all-team'} ${area.count===1?'square':'squares'}${newest}. Capture areas, not Explorer visit history.`;
 fitCaptureBounds(area.bounds);
}
$('find-capture-areas').onclick=()=>{
 if(!map)return;
 const cells=captureAreaCells();captureAreas=rankCaptureAreas(cells);captureAreaFingerprint=captureAreaKey(cells);captureAreaIndex=captureAreas.length?0:-1;
 updateCaptureAreaControls(cells);
 if(captureAreas.length)showCaptureArea();
 else $('capture-area-status').textContent=capturedSquaresHidden?'Show captured squares first to find capture areas.':'No squares match these filters. Widen the date range or change the team/player filter.';
};
$('next-capture-area').onclick=()=>{
 const cells=captureAreaCells();updateCaptureAreaControls(cells);
 if(!captureAreas.length)return;
 captureAreaIndex=(captureAreaIndex+1)%captureAreas.length;showCaptureArea();
};
$('all-capture-matches').onclick=()=>{
 if(!map)return;
 const cells=captureAreaCells();updateCaptureAreaControls(cells);
 if(!cells.length){$('capture-area-status').textContent=capturedSquaresHidden?'Show captured squares first to find capture areas.':'No squares match these filters.';return;}
 const bounds=L.latLngBounds(cells.flatMap(c=>[[c.south,c.west],[c.north,c.east]]));
 $('capture-area-status').textContent=`Showing all ${cells.length.toLocaleString()} matching squares across the loaded board. Capture times do not show all Explorer visits.`;
 fitCaptureBounds(bounds);
};
function drawBoard(){
 updateFilteredTeamScores();
 if(!map)return;
 territories.clearLayers();
 if(!board.length){
  if(targets)targets.clearLayers();
  $('capture-filter-status').textContent='0 squares match.';updateCaptureAreaControls([]);return;
 }
 scheduleSquareLookups();
 const bounds=map.getBounds();
 const now=Date.now()/1000;
 const eligible=board.filter(c=>captureVisible(c,now));
 updateCaptureAreaControls(eligible);
 $('capture-filter-status').textContent=`${capturedSquaresHidden?'Captured squares hidden. ':''}${eligible.length.toLocaleString()} of ${board.length.toLocaleString()} squares match the display filters for ${mapTeamFilter||'all teams'}${mapPlayerFilter?' · '+(mapPlayerFilter==='__unknown__'?'unknown capturer':mapPlayerFilter):''}.${captureDays>0?' Missing or future capture times are hidden.':''}`;
 const visible=eligible.filter(c=>bounds.intersects([[c.south,c.west],[c.north,c.east]]));
 if(targets && result?.routes?.[routeIndex])drawRouteTargets(result.routes[routeIndex]);
 if(visible.length>2500){return;}
 for(const c of visible){
  const rect=L.rectangle([[c.south,c.west],[c.north,c.east]],squareStyle(c)).addTo(territories);
  rect.squareData=c;
  rect.on('mouseover',()=>rect.setStyle({stroke:true,color:colors[c.owner_team]||'#888888',weight:1,opacity:.75}));
  rect.on('mouseout',()=>rect.setStyle(squareStyle(c)));
  const capturer=c.captured_by?` · Captured by ${escape(c.captured_by)}`:' · Capturer unknown';
  const captured=typeof c.captured_at==='number' && Number.isFinite(c.captured_at) && c.captured_at>0 ? ` · Captured ${new Date(c.captured_at*1000).toLocaleString()}` : '';
  rect.on('click',event=>{if(blockedRoadDrawing||areaDrawing||mapPickTarget)return;L.DomEvent.stopPropagation(event);showSquareDetails(c);});
  rect.bindTooltip(`${escape(c.owner_team)} · ${escape(c.cell_id)} · ${scoreLabel(c)}${capturer}${captured} · Click for API details`);
 }
 // Rebuilt fills must stay beneath target outlines and the selected route.
 if(targets)targets.eachLayer(layer=>layer.bringToFront?.());
 if(routeLayer)routeLayer.eachLayer(layer=>layer.bringToFront?.());
}
function updateDetailZoomControl(){
 if(!$('detail-zoom-readout')||!map)return;
 const zoom=map.getZoom();
 $('detail-zoom-readout').textContent=`Zoom ${zoom} · Details at ${squareLookupMinZoom}+`;
 $('detail-use-zoom').disabled=zoom<13;
 $('detail-use-zoom').title=zoom<13?'Zoom to level 13 or closer before choosing a detail threshold.':'Use the current zoom as the minimum for automatic square details.';
}
function initDetailZoomControl(){
 if(!automaticSquareRefreshEnabled)return;
 const control=L.control({position:'topleft'});
 control.onAdd=()=>{
  const panel=L.DomUtil.create('div','detail-zoom-control');
  panel.innerHTML='<span id="detail-zoom-readout" role="status"></span><button id="detail-use-zoom" type="button">Use this zoom for details</button>';
  L.DomEvent.disableClickPropagation(panel);L.DomEvent.disableScrollPropagation(panel);
  panel.querySelector('button').onclick=()=>{
   if(map.getZoom()<13)return;
   squareLookupMinZoom=map.getZoom();
   try{localStorage.setItem('square-detail-min-zoom',String(squareLookupMinZoom));}catch{}
   if(squareLookupTimer){clearTimeout(squareLookupTimer);squareLookupTimer=null;}
   squareLookupError='';scheduleSquareLookups();updateDetailZoomControl();
  };
  return panel;
 };
 control.addTo(map);updateDetailZoomControl();
}
function startSquareRefresh(cell){
 if(!squareRefreshLayers){
  const pane=map.createPane('square-refresh');pane.style.zIndex='450';pane.style.pointerEvents='none';
  squareRefreshRenderer=L.svg({pane:'square-refresh'}).addTo(map);
  squareRefreshLayers=L.layerGroup().addTo(map);
 }
 let entry=refreshingSquares.get(cell.cell_id);
 if(entry)entry.count++;
 else{
  const bounds=[[cell.south,cell.west],[cell.north,cell.east]];
  const style={renderer:squareRefreshRenderer,pane:'square-refresh',interactive:false,fill:false};
  const halo=L.rectangle(bounds,{...style,color:'#111827',weight:7,opacity:.9}).addTo(squareRefreshLayers);
  const outline=L.rectangle(bounds,{...style,color:'#00e5ff',weight:3,opacity:1,dashArray:'7 5',fill:true,fillColor:'#00e5ff',fillOpacity:.12,className:'square-refresh-outline'})
   .addTo(squareRefreshLayers).bindTooltip('Refreshing…',{permanent:true,direction:'center',className:'square-refresh-label'}).openTooltip();
  entry={count:1,halo,outline};refreshingSquares.set(cell.cell_id,entry);
 }
 return ()=>{
  entry.count--;
  if(entry.count===0){squareRefreshLayers.removeLayer(entry.halo);squareRefreshLayers.removeLayer(entry.outline);refreshingSquares.delete(cell.cell_id);}
 };
}
function squareViewportCells(){
 if(!map||squareLookupMoving||capturedSquaresHidden||!feedMetadata?.attribution?.configured||map.getZoom()<squareLookupMinZoom)return [];
 const bounds=map.getBounds(),now=Date.now()/1000;
 // Unknown player matches must be checked before the player filter can hide them.
 return board.filter(cell=>(!mapTeamFilter||cell.owner_team===mapTeamFilter)
  &&(captureDays===0||(typeof cell.captured_at==='number'&&cell.captured_at<=now&&cell.captured_at>=now-captureDays*86400))
  &&bounds.intersects([[cell.south,cell.west],[cell.north,cell.east]]));
}
function squareLookupCandidates(){
 if(!automaticSquareRefreshEnabled)return [];
 const visible=squareViewportCells();
 const center=map?.getCenter();
 return visible.filter(cell=>Date.now()-(squareLookupChecks.get(squareVersion(cell))||0)>squareLookupFreshMs)
  .sort((a,b)=>center.distanceTo([(a.south+a.north)/2,(a.west+a.east)/2])-center.distanceTo([(b.south+b.north)/2,(b.west+b.east)/2]));
}
function scheduleSquareLookups(){
 if(!automaticSquareRefreshEnabled){renderSquareLookupStatus(0);return;}
 if(document.hidden)return;
 const candidates=squareLookupCandidates();
 renderSquareLookupStatus(candidates.length);
 if(squareLookupBusy||squareLookupTimer||squareLookupMoving)return;
 if(!candidates.length){
  const visible=squareViewportCells();
  if(visible.length)squareLookupTimer=setTimeout(()=>{squareLookupTimer=null;scheduleSquareLookups();},squareLookupFreshMs);
  return;
 }
 squareLookupTimer=setTimeout(()=>{squareLookupTimer=null;loadNextSquare();},Math.max(600,squareLookupPauseUntil-Date.now()));
}
function renderSquareLookupStatus(count=squareLookupCandidates().length){
 updateDetailZoomControl();
 let status;
 if(!automaticSquareRefreshEnabled)status='Automatic square detail refresh is temporarily disabled. Click a square to view its API details.';
 else if(!feedMetadata?.attribution?.configured)status='Automatic square lookups require the MeshWars API token.';
 else if(map.getZoom()<squareLookupMinZoom)status=`Zoom in to level ${squareLookupMinZoom} or closer to load square details. Automatic lookups are paused at this zoom.`;
 else if(capturedSquaresHidden)status='Square lookups paused while captured squares are hidden.';
 else if(squareLookupMoving)status='Waiting for the map to stop moving…';
 else status=squareLookupError||(count?`Updating ${count.toLocaleString()} squares in this view, nearest first. Details are cached for 5 minutes; lookups are paced to about one per second.`:'Visible square details checked. Names may remain unknown in the API. Details refresh after 5 minutes while this view remains open.');
 $('square-lookup-status').textContent=status;
}
function renderMeshEvidence(){
 const records=[...meshSquareEvidence.values()];
 const verified=records.filter(d=>(d.evidence_summary?.verified_tx_count||0)>0).length;
 const passive=records.filter(d=>!(d.evidence_summary?.verified_tx_count>0)&&(d.evidence_summary?.passive_rx_count||0)>0).length;
 const unknown=records.length-verified-passive;
 $('mesh-evidence-status').textContent=feedMetadata?.attribution?.configured?
  `MeshWars token configured · ${records.length} squares inspected in this browser session. Click a square to load its evidence.`:
  'Set MESHWARS_API_KEY on the server to inspect square evidence.';
 $('mesh-evidence-counts').innerHTML=`<dl class="signal-intel-counts"><div><dt>Verified TX evidence</dt><dd>${verified} squares</dd></div><div><dt>Passive RX only</dt><dd>${passive} squares</dd></div><div><dt>Unknown / no TX or RX evidence</dt><dd>${unknown} squares</dd></div></dl>`;
}
function squareEvidenceDetails(detail){
 const evidence=detail.evidence_summary;
 if(!evidence)return '<p>Radio evidence: unknown. No summary was provided for this square.</p>';
 const number=key=>evidence[key]===null||evidence[key]===undefined?'Unknown':escape(evidence[key]);
 const hasEvidence=(evidence.verified_tx_count||0)>0||(evidence.passive_rx_count||0)>0;
 return `<p><strong>Radio evidence · square summary</strong><br>Verified TX reports: ${number('verified_tx_count')}<br>Passive RX reports: ${number('passive_rx_count')}<br>Other reports: ${number('other_count')}<br>Maximum watchers: ${number('max_watcher_count')}</p><p class="fine">${hasEvidence?'Historical evidence for this square; it does not guarantee coverage on every road. Passive RX alone does not prove your radio can transmit.':'Coverage unknown: zero or missing evidence is not a failed-transmission result.'} Observation ages and the summary history window are not supplied.</p>`;
}
function applySquareDetail(detail){
 meshSquareEvidence.set(detail.cell_id,detail);
 if(meshSquareEvidence.size>512)meshSquareEvidence.delete(meshSquareEvidence.keys().next().value);
 renderMeshEvidence();
 const event=detail.capture_event;
 const current=board.find(c=>c.cell_id===detail.cell_id);
 if(!current)return;
 const matching=detail.owner_team===current.owner_team&&detail.captured_at===current.captured_at;
 if(matching)squareLookupChecks.set(squareVersion(current),Date.now());
 if(event&&event.team===current.owner_team&&event.ts===current.captured_at){
  current.captured_by=event.player;renderPlayerFilter();drawBoard();
 }
 if(squareLookupChecks.size>20000)squareLookupChecks.delete(squareLookupChecks.keys().next().value);
}
async function loadNextSquare(){
 if(!automaticSquareRefreshEnabled)return;
 if(document.hidden||squareLookupBusy)return;
 const cell=squareLookupCandidates()[0];if(!cell)return;
 const version=squareVersion(cell);
 squareLookupBusy=true;
 const finishHighlight=startSquareRefresh(cell);
 try{
  const response=await fetch('/api/cells/'+encodeURIComponent(cell.cell_id),{cache:'no-store'});
  const detail=await response.json();if(!response.ok)throw Error(detail.error||'API lookup unavailable.');
  // Also remember unsuccessful name lookups and stale responses: do not spin on them.
  squareLookupChecks.set(version,Date.now());applySquareDetail(detail);
  squareLookupError='';squareLookupPauseUntil=Date.now()+1100;
 }catch(error){
  squareLookupError=`Capturer lookup paused: ${error.message} Retrying in one minute.`;
  squareLookupPauseUntil=Date.now()+60000;
 }finally{
  finishHighlight();squareLookupBusy=false;renderSquareLookupStatus();scheduleSquareLookups();
 }
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleSquareLookups();});
async function showSquareDetails(cell){
 const finishHighlight=startSquareRefresh(cell);
 const popup=L.popup({maxWidth:360,maxHeight:Math.max(80,map.getSize().y-110)}).setLatLng([(cell.south+cell.north)/2,(cell.west+cell.east)/2]).setContent('Loading square details…').openOn(map);
 try{
  const response=await fetch('/api/cells/'+encodeURIComponent(cell.cell_id),{cache:'no-store'});
  const detail=await response.json();if(!response.ok)throw Error(detail.error||'Square details unavailable.');
  applySquareDetail(detail);
  const scores=detail.scores&&typeof detail.scores==='object'?Object.entries(detail.scores).map(([team,value])=>`${escape(team)}: ${escape(value)}`).join('<br>'):'Unavailable';
  popup.setContent(`<strong>${escape(detail.cell_id)}</strong><p>Owner: ${escape(detail.owner_team)}<br>Captured by: ${escape(detail.captured_by||'Unknown')}<br>${detail.captured_at?'Captured: '+escape(new Date(detail.captured_at*1000).toLocaleString()):'Capture time unavailable'}</p><p>Defense scores<br>${scores}</p>${squareEvidenceDetails(detail)}<small>MeshWars square API · checked ${escape(new Date(detail.checked_at*1000).toLocaleTimeString())}. Names require an exact match to the current capture event.</small>`);
 }catch(error){popup.setContent(escape(error.message));}
 finally{finishHighlight();}
}
async function refreshRadioCoverage(){
 try{
  const response=await fetch('/api/radio-coverage',{cache:'no-store'});
  if(!response.ok)throw Error('Coverage source unavailable.');
  radioSnapshot=await response.json();
  drawRadioCoverage();
  // Read local startup progress only; upstream polling remains every 30 minutes.
  if(radioSnapshot.configured && !radioSnapshot.available && !radioSnapshot.error && radioStartupChecks++<20)setTimeout(refreshRadioCoverage,3000);
 }catch{
  $('radio-coverage-status').textContent='Coverage refresh unavailable. Previously loaded observations, if any, remain visible.';
 }
}
function drawRadioCoverage(){
 if(!radioLayer||!radioSnapshot)return;
 radioLayer.clearLayers();
 const meta=radioSnapshot,events=meta.events||[];
 const status=$('radio-coverage-status'),toggle=$('show-radio-coverage');
 toggle.disabled=!meta.configured||!meta.available||events.length===0;
 if(!meta.configured){
  toggle.checked=false;
  status.textContent='Direct FreqMapper point observations require a separate approved integration; the MeshWars token does not authorize that feed. MeshWars square evidence is available in Signal intel above and in clicked-square details. Route point coverage remains unknown.';
  return;
 }
 if(!meta.available && !meta.error){status.textContent='Loading the first coverage observations…';return;}
 const checked=meta.last_success?new Date(meta.last_success*1000).toLocaleString():'not yet';
 status.textContent=`${events.length.toLocaleString()} observations · Last checked: ${checked}. ${meta.stale?'Using incomplete or previously loaded evidence. ':''}${meta.history_pending?'History import is still in progress. ':''}${meta.error?`${meta.error} `:''}Failed-test evidence is not supplied by this feed.`;
 if(!$('show-radio-coverage').checked)return;
 const bounds=map.getBounds();
 const visible=events.filter(e=>bounds.contains([e.latitude,e.longitude]));
 if(visible.length>2000){status.textContent+=' Zoom in to display observations (more than 2,000 visible).';return;}
 for(const event of visible){
  const tx=event.event_type==='verified_tx';
  L.circleMarker([event.latitude,event.longitude],{radius:tx?5:4,color:tx?'#13865d':'#a366d6',weight:2,fillOpacity:tx ? .65 : 0})
   .addTo(radioLayer).bindTooltip(`${tx?'Verified mapping TX':'Passive RX only'}${event.quality?` · ${escape(event.quality)}`:''} · ${escape(new Date(event.occurred_at).toLocaleString())}`);
 }
}
function routeCoverageText(route){
 const evidence=route.radio_coverage?.targets;
 if(!evidence)return 'Radio coverage unknown';
 return `${evidence.verified_tx} targets near verified TX · ${evidence.passive_rx_only} near RX only · ${evidence.unknown} unknown`;
}
function routeCoverageDetails(route){
 const meta=result.radio_coverage||{},evidence=route.radio_coverage;
 const state=!meta.configured?'Coverage source not connected.':!meta.available?'Coverage evidence has not loaded.':meta.stale?'Previously loaded evidence; the latest refresh failed.':'Partial historical observations from FreqMapper.';
 return `<section class="route-radio-evidence"><h3>Radio evidence along this drive</h3><p>${escape(routeCoverageText(route))}</p><p class="fine">${escape(state)} ${evidence?`${evidence.verified_tx} crossed squares have nearby verified TX observations; ${evidence.passive_rx_only} have RX only; ${evidence.unknown} have no matching observations. `:''}Counts use the evidence available when this search started and require an observation in the same square and within 50 metres of the planned road. They describe evidence, not capture probability. Failed tests are unavailable; missing evidence stays unknown. Route ranking is unchanged.</p></section>`;
}
$('show-radio-coverage').onchange=drawRadioCoverage;
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
function markPlaceUsed(place){
 if(searching)return;
 if(excludedPlaceIds.has(place.id))excludedPlaceIds.delete(place.id);
 else{
  if(excludedPlaceIds.size>=500){$('place-settings-status').textContent='At most 500 places can be marked visited for one search.';return;}
  excludedPlaceIds.add(place.id);
 }
 document.querySelectorAll('[data-used-place]').forEach(button=>button.textContent=excludedPlaceIds.has(Number(button.dataset.usedPlace))?'Marked visited (undo)':'Already visited this week');
 $('place-settings-status').textContent=`${excludedPlaceIds.size} places marked already visited this week. Run a new search to update bonus estimates.`;
 drawBonusPlaces();
}
function drawBonusPlaces(){
 if(!bonusPlacesLayer)return;
 bonusPlacesLayer.clearLayers();
 for(const place of result?.places?.places||[]){
  const excluded=excludedPlaceIds.has(place.id),type=place.type;
  const content=document.createElement('div');
  const title=document.createElement('strong');title.textContent=place.name;
  const note=document.createElement('p');note.textContent=`${type} · ${place.points} potential points. ${type==='summit'?'Peak cell only; surrounding elevation eligibility unavailable.':type==='park'?'Park scoring area is conservatively estimated; no access or coverage is guaranteed.':'Point square plus eight adjacent squares.'}`;
  const button=document.createElement('button');button.type='button';button.textContent=excluded?'Mark as not yet visited':'Already visited this week';button.disabled=searching;button.onclick=()=>markPlaceUsed(place);
  content.append(title,note,button);
  L.marker([place.lat,place.lon],{title:`${place.name}: ${place.points} potential place points`,
   icon:L.divIcon({className:`bonus-place-icon${excluded?' used':''}`,html:`<span>${type==='summit'?'▲':type==='park'?'♣':'★'}</span>`,iconSize:[24,24],iconAnchor:[12,12]})})
   .addTo(bonusPlacesLayer).bindPopup(content);
 }
}
function missionValueDetails(route){
 const mode=result.mission||missionModes[route.mission_mode],weight=result.places?.weight??1;
 const rows=(route.mission_breakdown||[]).map(row=>`<tr><th scope="row">${escape(row.label)} (${row.count})</th><td>${utility(row.priority)}</td></tr>`).join('');
 const rules={
  offensive:'Enemy difficulty priority × 3; unpainted squares 0.2 each; place bonus priority × 0.25.',
  fortify:'Friendly priority is 2 ÷ (1 + owner score), or 0.25 for unknown scores; × 1.5 at an enemy border. Enemy, unpainted squares and place bonuses add no mission priority in Fortify.',
  frontier:'Unpainted squares sharing a side with friendly territory contribute 2; other unpainted squares 0.15; enemy difficulty priority × 0.2; place bonus priority × 0.25.',
  flanking:'Enemy and unpainted priority use the standard weights. Off-baseline share of crossed squares increases the subtotal by up to 75%; place bonus priority × 0.5.',
  special_ops:'Only eligible place bonuses contribute, at × 3 mission priority, after the entered bonus weight and weekly cap. Other squares add no mission priority.',
  supply:'Standard territory and place priority, discounted by 1 ÷ (1 + extra driving minutes / 3).',
 };
 return `<section class="route-value"><h3>${escape(mode?.name||route.mission_mode)} · value breakdown</h3><p>${escape(mode?.description||'')}</p><p><strong>(${utility(route.mission_territory_value)} territory/reinforcement priority + ${utility(route.place_bonus||0)} estimated place points × ${utility(weight)} entered weight × ${utility(route.mission_place_multiplier)} mission weight) × ${utility(route.mission_multiplier)} mission factor = ${utility(route.capture_value)} priority value</strong></p><table><caption>Mission priority breakdown</caption><thead><tr><th>Opportunity</th><th>Priority</th></tr></thead><tbody>${rows||'<tr><td>No territory priority in this mode</td><td>0</td></tr>'}</tbody></table><p class="fine">${escape(rules[route.mission_mode])} Enemy difficulty priority is 1 for owner scores at most 1, 1 ÷ score² for defended squares, or 0.5 for unknown scores.</p><p class="fine">Each square counts once. Priority is a ranking aid, not earned game points or a capture probability. Reinforcing friendly territory does not immediately add a square-held point. Place bonuses remain estimates, capped by your remaining weekly allowance; successful reports are required.</p></section>`;
}
function routeValueDetails(route){
 if(route.mission_mode&&route.mission_mode!=='balanced')return missionValueDetails(route);
 const b=route.territory_breakdown,weight=result.places?.weight??1;
 const bonus=route.place_bonus||0,territory=route.territory_value??(route.capture_value-bonus*weight);
 const rows=b?[
  ['Easy enemy squares',route.easy_enemy_count,b.easy_enemy,'1 each; owner score at most 1'],
  ['Defended enemy squares',route.hard_enemy_count,b.defended_enemy,'1 ÷ owner score² per square'],
  ['Enemy squares with unknown score',route.unknown_score_count,b.unknown_enemy,'0.5 each'],
  ['Unpainted exploration squares',route.unmapped_count,b.unpainted,'1 each; coverage unknown'],
 ].map(([name,count,value,rule])=>`<tr><th scope="row">${name} (${count})<small>${rule}</small></th><td>${utility(value)}</td></tr>`).join(''):'';
 return `<section class="route-value"><h3>Why this route ranks here</h3><p><strong>${utility(territory)} territory priority + ${utility(bonus)} estimated place points × ${utility(weight)} weight = ${utility(route.capture_value)} priority value</strong></p>${rows?`<table><caption>Territory priority breakdown</caption><thead><tr><th>Opportunity</th><th>Priority</th></tr></thead><tbody>${rows}</tbody></table>`:''}<p class="fine">Each square counts once per route. Your team's squares add no territory priority; eligible place bonuses can still apply. Owner score measures defense and is not the square's game-point reward. Priority is a ranking aid, not expected game points or guaranteed captures.</p><p class="fine">Places are counted once per place and capped at your entered weekly points remaining. Already-visited places are excluded. Coverage gaps can prevent capture; successful mesh reports are still required.${route.place_bonus_uncapped>bonus?` Before the weekly cap: ${utility(route.place_bonus_uncapped)} estimated place points.`:''}</p></section>`;
}
function placeBonusDetails(route){
 if(!result.places?.enabled)return '';
 const meta=result.places;
 const status=!meta.available?'Place feed unavailable; territory-only ranking.':`${meta.stale?'Cached this-week places. ':''}${meta.truncated||meta.eligibility_partial?'Source eligibility is incomplete. ':''}Estimated bonuses assume eligible, unvisited places and successful mesh reports. Park perimeter estimates may differ from game scoring; summit neighbors require elevation data we do not have.`;
 return `<section class="route-place-bonus"><h3>Estimated place bonuses</h3><p>${utility(route.place_bonus)} points · ${route.place_count||0} potential places · ${meta.remaining} weekly points remaining</p><p class="fine">${escape(status)} One place per square; revisits count once. Estimates are capped by your remaining weekly budget.</p><ul>${(route.bonus_places||[]).map(place=>`<li>${escape(place.name)} · ${escape(place.type)} · ${place.points} points <button type="button" data-used-place="${place.id}">${excludedPlaceIds.has(place.id)?'Marked visited (undo)':'Already visited this week'}</button></li>`).join('')}</ul></section>`;
}
function showActiveResult(){
 drawBonusPlaces();
 const hasRoutes=result.routes.length>0 || Object.values(result.strategy_results||{}).some(entry=>entry.routes.length>0);
 setPlanVisibility(hasRoutes);
 if(result.no_opportunities){
  routeLayer.clearLayers();targets.clearLayers();
  $('results').innerHTML=`<div class="empty"><h2>No useful route found</h2><p>${escape(result.message||'No opportunities for this mission within the budget. Try another mode or a larger allowance.')}</p></div>`;
 }else showRoute(0);
}
function drawRouteTargets(r){
 targets.clearLayers();
 const known = new Map(board.map(c=>[c.cell_id,c]));
 const reinforcement=new Set(r.reinforcement_ids||[]);
 for(const id of r.mission_target_ids||r.target_ids){
  const cell=known.get(id);
  if(!captureVisible(cell))continue;
  const [row,col]=id.split('_').map(Number);
  const bounds=cell ? [[cell.south,cell.west],[cell.north,cell.east]] : [[row*.0027,col*.00384],[(row+1)*.0027,(col+1)*.00384]];
  L.rectangle(bounds,{color:reinforcement.has(id)?'#d79d24':'#15966c',weight:2,dashArray:cell?null:'4 4',fillOpacity:cell?0:.18}).addTo(targets).bindTooltip(reinforcement.has(id)?`Friendly reinforcement · ${scoreLabel(cell)}`:cell?`Enemy target · ${escape(cell.owner_team)} · ${scoreLabel(cell)}`:'Unpainted exploration · coverage unknown');
 }
}
function showRoute(index){
 routeIndex=index;
 const r=result.routes[index], base=result.baseline;
 routeLayer.clearLayers();
 targets.clearLayers();
 drawRouteTargets(r);
 L.geoJSON(base.geometry,{style:{color:'#8494aa',weight:5,opacity:.55}}).addTo(routeLayer);
 L.geoJSON(r.geometry,{style:{color:'#172238',weight:10,opacity:.95,lineCap:'round',lineJoin:'round'}}).addTo(routeLayer);
 const line=L.geoJSON(r.geometry,{style:{color:routeColor(result.team),weight:6,opacity:1,lineCap:'round',lineJoin:'round'}}).addTo(routeLayer);
 map.fitBounds(line.getBounds(),{padding:[25,25]});
 const standardCount=result.routes.filter(v=>v.route_kind!=='wild').length;
 const hasWild=result.routes.some(v=>v.route_kind==='wild');
 const cards=result.routes.map((v,i)=>`<button class="card ${i===index?'selected':''}" data-route="${i}" data-route-kind="${v.route_kind||'standard'}" aria-pressed="${i===index}">${v.route_kind==='wild'?`Wild route ${i-standardCount+1}`:i===0?`Best ${hasWild?'standard ':''}${result.team} opportunity`:`Alternative ${i+1}`}<b>${utility(v.capture_value)} priority value</b><small>${v.reinforcement_count?`${v.reinforcement_count} reinforcement targets<br>`:''}${v.frontier_count&&v.mission_mode==='frontier'?`${v.frontier_count} adjoining unpainted squares<br>`:''}${v.route_kind==='wild'?`${escape(v.wild_direction)}<br>`:''}${v.target_count} raw targets · ${v.easy_enemy_count} easy enemy<br>${v.hard_enemy_count} defended · ${v.unknown_score_count} unknown score · ${v.unmapped_count} unpainted<br>${minutes(v.duration)} · ${miles(v.distance)}<br>+${minutes(Math.max(0,v.duration-base.duration))} vs fastest${v.budget_used_fraction!==undefined?` · ${Math.round(v.budget_used_fraction*100)}% of extra-time budget`:''}<br>${escape(routeCoverageText(v))}${v.place_bonus?`<br>+${utility(v.place_bonus)} estimated place points · ${v.place_count} places`:""}</small></button>`).join('');
 const steps=[];
 r.legs.forEach((leg,legIndex)=>leg.steps.forEach(step=>{
  let text=instruction(step);
  if(step.maneuver.type==='arrive')text=legIndex===r.legs.length-1?'Arrive at Finish':`Reach ${r.stop_labels?.[legIndex]||'exploration detour'}; continue to the next leg`;
  steps.push(`<li><span>${escape(text)}</span><small>${miles(step.distance)}</small></li>`);
 }));
 $('results').innerHTML=`<div class="cards">${cards}</div><div class="routehead"><h2>Route briefing</h2><div class="route-actions"><button id="phone-navigation" aria-expanded="false" aria-controls="navigation-modal" aria-haspopup="dialog">Navigate / send to phone</button><button id="download">GeoJSON</button><button id="clear-displayed-route" type="button">Clear route</button></div></div>${result.mission?`<p class="mission-brief"><strong>${escape(result.mission.name)}</strong> · ${escape(result.mission.description)}</p>`:''}<p class="trip">Start: ${escape(tripLabels?.start||$('start').value)}${(tripLabels?.waypoints||[]).map((label,index)=>` → W${index+1}: ${escape(label)}`).join('')} → Finish: ${escape(tripLabels?.end||$('end').value)}<br>${minutes(r.duration)} · ${miles(r.distance)} · ${utility(r.capture_value)} weighted value${r.mission_mode&&r.mission_mode!=='balanced'?'':r.place_bonus?`<br>${utility(r.territory_value)} territory priority + ${utility(r.place_bonus)} estimated place points × ${result.places?.weight??1}`:''}<br>${r.easy_enemy_count} easy enemy · ${r.hard_enemy_count} defended enemy · ${r.unknown_score_count} unknown score<br>${r.enemy_count} enemy + ${r.unmapped_count} unpainted / ${r.square_count} squares crossed<br>Fastest baseline: ${minutes(base.duration)} · ${miles(base.distance)} · ${base.target_count} target squares · ${utility(base.capture_value)} weighted value</p>${routeValueDetails(r)}${routeCoverageDetails(r)}${placeBonusDetails(r)}<ol class="steps">${steps.join('')}</ol>`;
 document.querySelectorAll('[data-route]').forEach(el=>el.onclick=()=>showRoute(Number(el.dataset.route)));
 document.querySelectorAll('[data-used-place]').forEach(button=>button.onclick=()=>{
  const place=r.bonus_places.find(place=>place.id===Number(button.dataset.usedPlace));
  markPlaceUsed(place);
 });
 $('clear-displayed-route').onclick=()=>{
  if(searching)return;
  clearDisplayedRoute();$('status').textContent='Route cleared. Your trip inputs and area are ready for another search.';
 };
 $('phone-navigation').onclick=()=>openNavigation(r);
 $('download').onclick=()=>{
  const blob=new Blob([JSON.stringify({type:'Feature',geometry:r.geometry,properties:{team:result.team,mission_mode:result.mission_mode,mission:result.mission,mission_breakdown:r.mission_breakdown,reinforcement_count:r.reinforcement_count,place_bonus:r.place_bonus,bonus_places:r.bonus_places,territory_value:r.territory_value,allowed_bounds:result.allowed_bounds,blocked_roads:result.blocked_roads,radio_coverage:r.radio_coverage,duration_seconds:r.duration,target_count:r.target_count,capture_value:r.capture_value,easy_enemy_count:r.easy_enemy_count,hard_enemy_count:r.hard_enemy_count,required_waypoints:result.required_waypoints}},null,2)],{type:'application/geo+json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${result.team.toLowerCase()}-route.geojson`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
}
function saveFile(blob,name){
 const url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function drawQr(container,url,label='Scan with your phone camera to open this Google Maps section'){
 if(typeof window.qrcode!=='function'){container.textContent='QR library unavailable. Copy the link instead.';return;}
 try{
  const code=window.qrcode(0,'M');code.addData(url);code.make();
  const count=code.getModuleCount(),scale=6,quiet=4,canvas=document.createElement('canvas');
  canvas.width=canvas.height=(count+quiet*2)*scale;
  canvas.setAttribute('role','img');canvas.setAttribute('aria-label',label);
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000';
  for(let row=0;row<count;row++)for(let col=0;col<count;col++)if(code.isDark(row,col))ctx.fillRect((col+quiet)*scale,(row+quiet)*scale,scale,scale);
  container.replaceChildren(canvas);
 }catch{container.textContent='Could not generate QR. Copy the link instead.';}
}
function drawHandoffPreview(container,data,route,team,area){
 const preview=data.preview;
 const previewMap=L.map(container.querySelector('.handoff-preview-map'),{scrollWheelZoom:false});
 try{
 // Establish renderer bounds before adding the area and any vector layers.
 const path=L.geoJSON(route.geometry,{style:{color:routeColor(team),weight:6,opacity:1}});
 previewMap.fitBounds(path.getBounds(),{padding:[30,30],maxZoom:16,animate:false});
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(previewMap);
 L.geoJSON(route.geometry,{style:{color:'#172238',weight:10,opacity:.95}}).addTo(previewMap);
 path.addTo(previewMap);
 if(area){
  if(area.type==='Polygon')L.geoJSON(area,{style:{color:'#f59e0b',weight:1,dashArray:'6 5',fillOpacity:0}}).addTo(previewMap);
  else L.rectangle([[area.south,area.west],[area.north,area.east]],{color:'#f59e0b',weight:1,dashArray:'6 5',fillOpacity:0,interactive:false}).addTo(previewMap);
 }
 const gaps=preview.legs.map(leg=>L.geoJSON(leg.geometry,{style:{color:leg.long_gap?'#e69524':routeColor(team),weight:leg.long_gap?6:4,opacity:.9,dashArray:leg.long_gap?'9 7':null}}).addTo(previewMap));
 const stops=[],labels=[];
 for(const [index,section] of data.sections.entries()){
  stops.push(...section.stops.slice(index?1:0));
  labels.push(...section.labels.slice(index?1:0));
 }
 stops.forEach((point,index)=>{
  const label=document.createElement('span');label.textContent=`${index+1}. ${labels[index]}`;
  L.marker([point[1],point[0]],{title:`Export stop ${index+1}: ${labels[index]}`,alt:`Export stop ${index+1}`,icon:L.divIcon({className:'handoff-stop-icon',html:`<span style="background:${colors[team]}">${index+1}</span>`,iconSize:[28,28],iconAnchor:[14,14]})})
   .addTo(previewMap).bindTooltip(label,{direction:'top'});
 });
 const list=container.querySelector('.handoff-gap-list');
 preview.legs.forEach((leg,index)=>{
  const item=document.createElement('li'),button=document.createElement('button');
  button.type='button';button.className=leg.long_gap?'handoff-gap long-gap':'handoff-gap';
  button.textContent=`${leg.from_stop} → ${leg.to_stop}: ${miles(leg.distance_meters)}${leg.long_gap?' · Long gap':''}`;
  button.setAttribute('aria-label',`${button.textContent}. Zoom to this part of the planned route.`);
  button.onclick=()=>{
   gaps.forEach((layer,i)=>layer.setStyle({weight:i===index?8:4,opacity:i===index?1:.55}));
   list.querySelectorAll('button').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));
   previewMap.fitBounds(gaps[index].getBounds(),{padding:[30,30],maxZoom:17,animate:false});
  };
  button.setAttribute('aria-pressed','false');item.append(button);list.append(item);
 });
 const fit=()=>{
  gaps.forEach((layer,i)=>layer.setStyle({weight:preview.legs[i].long_gap?6:4,opacity:.9}));
  list.querySelectorAll('button').forEach(el=>el.setAttribute('aria-pressed','false'));
  previewMap.invalidateSize({pan:false});
  previewMap.fitBounds(path.getBounds(),{padding:[30,30],maxZoom:16,animate:false});
 };
 container.querySelector('.handoff-fit-route').onclick=fit;
 fit();
 return {map:previewMap,fit};
 }catch(error){previewMap.remove();throw error;}
}
async function openNavigation(route){
 const button=$('phone-navigation'),team=result.team,routeArea=result.allowed_bounds;
 let handoffPreview=null;
 if($('navigation-modal'))return;
 const modal=document.createElement('dialog');
 modal.id='navigation-modal';modal.setAttribute('aria-labelledby','navigation-modal-title');
 modal.innerHTML='<div class="navigation-modal-heading"><h2 id="navigation-modal-title">Take this drive on your phone</h2><button type="button" id="navigation-close" autofocus aria-label="Close phone navigation">Close ×</button></div><div id="navigation-handoff"></div>';
 document.body.append(modal);
 const panel=modal.querySelector('#navigation-handoff'),controller=new AbortController();
 modal.querySelector('#navigation-close').onclick=()=>modal.close();
 modal.addEventListener('click',event=>{
  if(event.target!==modal)return;
  const bounds=modal.getBoundingClientRect();
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)modal.close();
 });
 modal.addEventListener('close',()=>{
  controller.abort();handoffPreview?.map.remove();modal.remove();document.body.classList.remove('navigation-modal-open');
  if(button.isConnected){button.disabled=false;button.setAttribute('aria-expanded','false');button.focus();}
 },{once:true});
 modal.showModal();document.body.classList.add('navigation-modal-open');
 button.disabled=true;button.setAttribute('aria-expanded','true');
 panel.textContent='Preparing navigation links and GPX track…';
 try{
  const response=await fetch('/api/route-export',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({route:{team:team,geometry:route.geometry,via_points:route.via_points||[],stop_labels:route.stop_labels||[]}})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Export failed.');
  // A route switch may have removed this panel while export was being prepared.
  if(!panel.isConnected)return;
  panel.innerHTML=`<div class="handoff-tabs" role="group" aria-label="Phone handoff view"><button id="handoff-show-preview" type="button" aria-pressed="true" aria-controls="handoff-preview-pane">Route preview</button><button id="handoff-show-qr" type="button" aria-pressed="false" aria-controls="handoff-qr-pane">QR &amp; sharing</button></div><section id="handoff-preview-pane"><h3>Planned route &amp; exported stops</h3><p>${data.preview.intermediate_stop_count} intermediate stops · ${data.sections.length} QR ${data.sections.length===1?'code':'codes'} · up to ${data.preview.waypoint_limit} intermediate stops per app link.</p><div class="handoff-preview-map" aria-label="Planned route with numbered Google Maps export stops"></div><div class="handoff-preview-key"><span>Solid: planned route</span><span>Amber dashes: gaps over 2 km</span><button class="handoff-fit-route" type="button">Fit whole route</button></div><p class="fine">Numbered pins are the coordinates sent to Google Maps, in order. Select a gap below to inspect it. Amber marks longer distances between stops, where Google has more room to choose different roads; shorter gaps can change too. This shows our planned geometry, not a route returned by Google. Stops may snap to nearby streets.</p><ol class="handoff-gap-list" aria-label="Distances between exported stops"></ol></section><div id="handoff-qr-pane" hidden><p>${data.sections.length===1?'Scan this QR code to open the complete drive in the Google Maps app on Android or iPhone.':'This drive exceeds nine intermediate stops, so it uses multiple Google Maps app links. Scan or copy/share all section links before leaving, then open them in order.'} No email or access to this local app is needed. If the link opens in a mobile browser, open it in the Google Maps app to retain all stops.</p><div id="navigation-sections"></div><p class="handoff-note">Google Maps recalculates roads between the stops and may skip capture streets. ${result.allowed_bounds||result.blocked_roads?.length?'It can also recalculate outside your drawn route area or onto roads you marked blocked. ':''}Check its preview before starting. GPX preserves the complete planned track for a compatible track-following app; it does not contain spoken instructions.</p><div class="route-actions"><button id="navigation-copy-all">Copy all navigation links</button><button id="navigation-share-all" hidden>Share all links</button></div><div class="route-actions handoff-file-actions"><button id="gpx-download">Download GPX track</button><button id="gpx-share" hidden>Share GPX file</button></div><p class="fine">Transfer the GPX file using AirDrop, Quick Share, your files/cloud app, or email. Import it in a navigation app that supports following GPX tracks. ${data.trackpoint_count.toLocaleString()} track points retained.</p><section class="gpx-qr-card"><h3>GPX for OsmAnd</h3><p>Scan a download link on your phone, then use Share → OsmAnd to import the full track. Your phone must be able to reach this site; this is a file download, not one-tap navigation.</p><button id="gpx-create-qr" type="button">Create GPX download QR</button><p id="gpx-qr-status" class="fine" role="status" aria-live="polite"></p><div id="gpx-qr-result" hidden><div class="navigation-qr gpx-download-qr"></div><div class="route-actions"><a id="gpx-qr-open" class="navigation-open" target="_blank" rel="noopener noreferrer">Download GPX</a><button id="gpx-qr-copy" type="button">Copy GPX link</button><button id="gpx-qr-share" type="button" hidden>Share GPX link</button></div><input id="gpx-qr-url" class="navigation-url" readonly aria-label="Temporary GPX download link"></div></section><p id="handoff-status" role="status" aria-live="polite"></p></div>`;
  try{handoffPreview=drawHandoffPreview(panel.querySelector('#handoff-preview-pane'),data,route,team,routeArea);}
  catch{panel.querySelector('#handoff-preview-pane').textContent='The map preview could not load. Your QR codes, links, and GPX export remain available under QR & sharing.';}
  const showHandoffPane=showPreview=>{
   panel.querySelector('#handoff-preview-pane').hidden=!showPreview;
   panel.querySelector('#handoff-qr-pane').hidden=showPreview;
   panel.querySelector('#handoff-show-preview').setAttribute('aria-pressed',String(showPreview));
   panel.querySelector('#handoff-show-qr').setAttribute('aria-pressed',String(!showPreview));
   if(showPreview)handoffPreview?.map.invalidateSize({pan:false});
  };
  panel.querySelector('#handoff-show-preview').onclick=()=>showHandoffPane(true);
  panel.querySelector('#handoff-show-qr').onclick=()=>showHandoffPane(false);
  if(!handoffPreview)showHandoffPane(false);
  const allLinks=data.sections.map((section,index)=>`Section ${index+1}/${data.sections.length}: ${section.from_label} → ${section.to_label}\n${section.url}`).join('\n\n');
  const allLinksText=`MeshWars ${team} drive — Google may recalculate roads. Open sections in order.\n\n${allLinks}`;
  panel.querySelector('#navigation-copy-all').onclick=async()=>{
   try{await navigator.clipboard.writeText(allLinksText);panel.querySelector('#handoff-status').textContent='All navigation links copied. Paste them into your preferred phone transfer app.';}
   catch{const text=document.createElement('textarea');text.value=allLinksText;text.setAttribute('aria-label','All navigation links');panel.append(text);text.focus();text.select();panel.querySelector('#handoff-status').textContent='Links selected. Copy them with your keyboard or browser menu.';}
  };
  if(navigator.share){const button=panel.querySelector('#navigation-share-all');button.hidden=false;button.onclick=async()=>{
   try{await navigator.share({title:`MeshWars ${team} navigation sections`,text:allLinksText});}
   catch(error){if(error.name!=='AbortError')panel.querySelector('#handoff-status').textContent='Sharing unavailable. Use Copy all navigation links.';}
  };}
  const file=new File([data.gpx],`${team.toLowerCase()}-route.gpx`,{type:'application/gpx+xml'});
  panel.querySelector('#gpx-download').onclick=()=>saveFile(file,`${team.toLowerCase()}-route.gpx`);
  const gpxQRButton=panel.querySelector('#gpx-create-qr'),gpxQRStatus=panel.querySelector('#gpx-qr-status');
  const loopbackHost=/^(localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/.test(location.hostname)||location.hostname.endsWith('.localhost');
  if(loopbackHost)gpxQRStatus.textContent='Localhost link: a phone cannot reach this address. You can preview the QR now; use it after opening the planner at a phone-accessible address.';
  gpxQRButton.onclick=async()=>{
   gpxQRButton.disabled=true;
   const previousStatus=gpxQRStatus.textContent;
   gpxQRStatus.textContent='Creating a temporary download link…';
   try{
    const response=await fetch('/api/gpx-shares',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({route:{team,geometry:route.geometry,via_points:route.via_points||[],stop_labels:route.stop_labels||[]}})});
    const share=await response.json();if(!response.ok)throw Error(share.error||'Could not create a GPX link.');
    if(!panel.isConnected)return;
    const url=new URL(share.download_path,location.origin).href;
    const holder=panel.querySelector('#gpx-qr-result'),input=panel.querySelector('#gpx-qr-url');
    holder.hidden=false;input.value=url;input.onclick=()=>input.select();
    panel.querySelector('#gpx-qr-open').href=url;
    drawQr(holder.querySelector('.gpx-download-qr'),url,'Scan with your phone camera to download this GPX track for import into OsmAnd');
    const expiry=new Date(share.expires_at*1000).toLocaleTimeString();
    gpxQRStatus.textContent=`Link expires at ${expiry} (1 hour), or when the server restarts. Anyone with the link can download this track. ${loopbackHost?'This localhost URL is not reachable from your phone.':'Your phone must be able to reach this site; any site login still applies.'}`;
    gpxQRButton.textContent='Create a new GPX link';
    panel.querySelector('#gpx-qr-copy').onclick=async()=>{
     try{await navigator.clipboard.writeText(url);panel.querySelector('#handoff-status').textContent='GPX download link copied.';}
     catch{input.focus();input.select();panel.querySelector('#handoff-status').textContent='GPX link selected. Copy it using your browser menu.';}
    };
    const shareButton=panel.querySelector('#gpx-qr-share');
    if(navigator.share){shareButton.hidden=false;shareButton.onclick=async()=>{
     try{await navigator.share({title:`${team} GPX track for OsmAnd`,url});}
     catch(error){if(error.name!=='AbortError')panel.querySelector('#handoff-status').textContent='Sharing unavailable. Copy the GPX link or scan its QR.';}
    };}
   }catch(error){
    if(error.name==='AbortError')gpxQRStatus.textContent=previousStatus;
    else gpxQRStatus.textContent=error.message;
   }finally{if(gpxQRButton.isConnected)gpxQRButton.disabled=false;}
  };
  const shareFile=panel.querySelector('#gpx-share');
  if(navigator.share && navigator.canShare?.({files:[file]})){
   shareFile.hidden=false;
   shareFile.onclick=async()=>{try{await navigator.share({files:[file],title:`MeshWars ${team} route`});}catch(error){if(error.name!=='AbortError')panel.querySelector('#handoff-status').textContent='File sharing unavailable. Download GPX and transfer it manually.';}};
  }
  for(const [index,section] of data.sections.entries()){
   const card=document.createElement('section');card.className='navigation-section';
   card.innerHTML=`<h4>${data.sections.length===1?'Complete drive':`Section ${index+1} of ${data.sections.length}` }: ${escape(section.from_label)} → ${escape(section.to_label)}</h4><p class="fine">${section.labels.map(escape).join(' → ')}</p><div class="navigation-qr"></div><div class="route-actions"><a class="navigation-open" target="_blank" rel="noopener noreferrer">Open Google Maps</a><button class="navigation-copy">Copy link</button><button class="navigation-share" hidden>Share link</button></div><input class="navigation-url" readonly aria-label="Google Maps section ${index+1} link">`;
   const input=card.querySelector('input');input.value=section.url;input.onclick=()=>input.select();
   card.querySelector('a').href=section.url;
   drawQr(card.querySelector('.navigation-qr'),section.url);
   card.querySelector('.navigation-copy').onclick=async()=>{
    try{await navigator.clipboard.writeText(section.url);panel.querySelector('#handoff-status').textContent=`Section ${index+1} link copied.`;}
    catch{input.focus();input.select();panel.querySelector('#handoff-status').textContent='Link selected. Copy it with your keyboard or browser menu.';}
   };
   const share=card.querySelector('.navigation-share');
   if(navigator.share){share.hidden=false;share.onclick=async()=>{try{await navigator.share({title:`${team} route — section ${index+1}`,url:section.url});}catch(error){if(error.name!=='AbortError')panel.querySelector('#handoff-status').textContent='Sharing unavailable. Use Copy link or scan the QR code.';}};}
   panel.querySelector('#navigation-sections').append(card);
  }
 }catch(error){if(panel.isConnected && error.name!=='AbortError')panel.textContent=error.message;}
 finally{if(button.isConnected)button.disabled=false;}
}
function initPanelResize(){
 const workspace=document.querySelector('.workspace'),divider=$('map-divider');
 let ratio=.6,dragging=false,frame=null;
 try{const saved=Number(localStorage.getItem('blue-map-split'));if(saved>0 && saved<1)ratio=saved;}catch{}
 function bounds(){
  const available=Math.max(0,workspace.clientHeight-divider.offsetHeight-$('map-filters').offsetHeight-$('map-pick-banner').offsetHeight-$('search-running-banner').offsetHeight);
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
  apply(event.clientY-workspace.getBoundingClientRect().top-$('map-filters').offsetHeight-$('map-pick-banner').offsetHeight-$('search-running-banner').offsetHeight-divider.offsetHeight/2);
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
 if(window.ResizeObserver){const observer=new ResizeObserver(resize);observer.observe(workspace);observer.observe($('map-filters'));observer.observe($('map-pick-banner'));observer.observe($('search-running-banner'));}
 else window.addEventListener('resize',resize);
 window.addEventListener('beforeprint',redrawMap);
 window.addEventListener('afterprint',resize);
 resize();
}
function setTeamMapFilter(team){
 mapTeamFilter=mapTeamFilter===team?null:team;
 renderTeamScores();drawBoard();
 $('team-score-list').querySelector(`[data-team="${team}"] button`)?.focus();
}
$('team-filter-clear').onclick=()=>{mapTeamFilter=null;renderTeamScores();drawBoard();};
function updateFilteredTeamScores(){
 const counts=Object.fromEntries(Object.keys(colors).map(team=>[team,0]));
 const now=Date.now()/1000;
 for(const cell of board){
  if(Object.hasOwn(counts,cell.owner_team)&&captureAgeVisible(cell,now))counts[cell.owner_team]++;
 }
 for(const team of Object.keys(colors)){
  const label=$(`filtered-score-${team}`);
  if(!label)continue;
  label.hidden=captureDays===0;
  label.textContent=boardAvailable?`${counts[team].toLocaleString()} territory pts · last ${captureDays} ${captureDays===1?'day':'days'}`:'Filtered territory score unavailable';
  label.title='One territory point per currently held square matching the capture-age filter, across the full board. Excludes check-in and exploration bonuses. Missing or future capture times are excluded. Team, player, map viewport and hide-square filters do not affect this count.';
 }
}
function renderTeamScores(){
 const counts=Object.fromEntries(Object.keys(colors).map(team=>[team,0]));
 for(const cell of board){if(Object.hasOwn(counts,cell.owner_team))counts[cell.owner_team]++;}
 const scores=feedMetadata?.team_scores;
 const liveScores=scores?.available?new Map(scores.teams.map(row=>[row.team,row])):null;
 const entries=Object.keys(colors).map(team=>({team,score:liveScores?.get(team)?.total,
  count:liveScores?.get(team)?.tiles??(boardAvailable?counts[team]:null),details:liveScores?.get(team)}));
 entries.sort((a,b)=>(b.score??b.count??-1)-(a.score??a.count??-1)||Object.keys(colors).indexOf(a.team)-Object.keys(colors).indexOf(b.team));
 $('team-score-list').innerHTML=entries.map(({team,score,count,details})=>`<li class="team-score ${team===selectedTeam()?'selected':''} ${mapTeamFilter===team?'filtered':''} ${mapTeamFilter&&mapTeamFilter!==team?'muted':''}" data-team="${team}" style="--score-team-color:${colors[team]}"><button class="team-score-filter" type="button" aria-describedby="filtered-score-${team}" aria-pressed="${mapTeamFilter===team}" aria-label="${team}: ${score===undefined?'points unavailable':`${score} points`}, ${count===null?'territory unavailable':`${count} squares held`}. Filter map to ${team}${team===selectedTeam()?', your planning team':''}" title="${details?`${details.tiles.toLocaleString()} squares + ${details.checkin_points.toLocaleString()} check-in + ${details.explorer_points.toLocaleString()} exploration points. `:'Total points unavailable. '}Click to show only ${team}; click again to show all teams."><span class="team-score-name"><i aria-hidden="true"></i>${team}${team===selectedTeam()?' · you':''}</span><strong>${score===undefined?'—':Number(score).toLocaleString(undefined,{maximumFractionDigits:2})}<span class="team-score-unit"> points</span></strong><span class="team-score-captures">${count===null?'—':Number(count).toLocaleString()} ${count===1?'square':'squares'} held</span><span id="filtered-score-${team}" class="team-score-filtered" hidden></span></button></li>`).join('');
 updateFilteredTeamScores();
 $('team-score-list').querySelectorAll('button').forEach(button=>button.onclick=()=>setTeamMapFilter(button.closest('[data-team]').dataset.team));
 $('team-filter-clear').hidden=!mapTeamFilter;
 const source=$('team-scores-source');
 const stale=feedMetadata?.stale||scores?.stale;
 source.textContent=liveScores?`${stale?'Cached · ':''}Total points + squares held${mapTeamFilter?` · Showing ${mapTeamFilter}`:''}`:
  `${boardAvailable&&stale?'Cached · ':''}${boardAvailable?'Points unavailable · board counts only':'Waiting for board data…'}${mapTeamFilter?` · Showing ${mapTeamFilter}`:''}`;
 source.title=liveScores?`Meshtastic scoreboard: squares held plus check-in and exploration points. Checked ${scores.last_success?new Date(scores.last_success*1000).toLocaleString():'at an unknown time'}. Map filters do not change totals. Squares held are current territory, not all-time capture events.`:
  'The scoreboard feed has not loaded. Points remain unknown; territory counts use the loaded board. Map filters do not change totals.';
}
function renderPlayerFilter(){
 const names=new Map();
 for(const p of playerRoster?.players||[])names.set(p.name.toLocaleLowerCase(),{name:p.name,team:p.team});
 for(const cell of board)if(cell.captured_by&&!names.has(cell.captured_by.toLocaleLowerCase()))names.set(cell.captured_by.toLocaleLowerCase(),{name:cell.captured_by});
 if(mapPlayerFilter&&mapPlayerFilter!=='__unknown__'&&!names.has(mapPlayerFilter.toLocaleLowerCase()))names.set(mapPlayerFilter.toLocaleLowerCase(),{name:mapPlayerFilter});
 $('player-filter').innerHTML='<option value="">All players</option><option value="__unknown__">Unknown capturer</option>'+[...names.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<option value="${escape(p.name)}">${escape(p.name)}${p.team?' · '+escape(p.team):''}</option>`).join('');
 $('player-filter').value=mapPlayerFilter;
 const known=board.filter(c=>c.captured_by).length,meta=feedMetadata?.attribution;
 $('player-filter-status').textContent=`${playerRoster?.players?.length||0} registered players · ${known.toLocaleString()} of ${board.length.toLocaleString()} squares have a confirmed capturer. ${meta?.configured?'':'Capture attribution needs a configured API token. '}${meta?.error||''} ${playerRoster?.stale?'Roster is cached. ':''}${playerRoster?.error||''}`;
}
$('player-filter').onchange=()=>{mapPlayerFilter=$('player-filter').value;drawBoard();};
async function refreshPlayers(){
 try{
  const response=await fetch('/api/players',{cache:'no-store'});if(!response.ok)throw Error();
  playerRoster=await response.json();
 }catch{playerRoster={...(playerRoster||{}),stale:true,error:'Player roster unavailable; known capture names remain selectable.'};}
 renderPlayerFilter();
}
function renderFeedStatus(){
 renderTeamScores();renderPlayerFilter();renderMeshEvidence();
 if(!feedMetadata)return;
 const meta=feedMetadata;
 const stamp=value=>value?new Date(value*1000).toLocaleString():'not yet';
 const state=meta.refreshing?'Refreshing MeshWars…':meta.stale?'Using fallback data':'Live feed';
 $('board-feed-status').textContent=`${state} · ${meta.coverage_count.toLocaleString()} squares. Last successful check: ${stamp(meta.last_success)}. Last attempt: ${stamp(meta.last_checked)}. Automatic check interval: ${meta.error?meta.retry_interval:meta.refresh_interval}s. ${meta.error||meta.cache_error||''} ${meta.board_endpoint==='authenticated-api'?'Authenticated API board. ':''}${meta.data_warning||''}`;
 document.querySelector('.board-feed').dataset.stale=String(meta.stale);
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
  // Poll only the local startup state; upstream remains on its 30-minute schedule.
  if(!data.available && boardStartupChecks++<20)setTimeout(()=>refreshBoard(true),3000);
  if(data.available && Array.isArray(data.coverage)){
   board=data.coverage;boardRevision=data.revision;boardAvailable=true;
   drawBoard();
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
function cancelBlockedRoadDrawing(){
 blockedRoadDrawing=null;
 if(blockedRoadPreview){map.removeLayer(blockedRoadPreview);blockedRoadPreview=null;}
 $('draw-blocked-road').textContent='Mark roadblock';$('draw-blocked-road').setAttribute('aria-pressed','false');
 $('finish-blocked-road').disabled=true;$('undo-blocked-road').disabled=true;
}
function drawBlockedRoads(){
 if(!map)return;
 if(!blockedRoadLayer){
  const pane=map.createPane('road-blocks');pane.style.zIndex='460';pane.style.pointerEvents='none';
  blockedRoadLayer=L.layerGroup().addTo(map);
 }
 blockedRoadLayer.clearLayers();
 blockedRoads.forEach((road,index)=>{
  const points=road.coordinates.map(([lon,lat])=>[lat,lon]);
  L.polyline(points,{pane:'road-blocks',color:'#fff',weight:9,opacity:.9,interactive:false}).addTo(blockedRoadLayer);
  L.polyline(points,{pane:'road-blocks',color:'#e44444',weight:5,dashArray:'9 5',interactive:false}).addTo(blockedRoadLayer).bindTooltip(`Blocked road ${index+1}`,{permanent:true,direction:'top'});
 });
 $('clear-blocked-roads').disabled=searching||!blockedRoads.length;
 if(!blockedRoadDrawing)$('blocked-road-status').textContent=blockedRoads.length?`${blockedRoads.length} blocked road sections. Routes must avoid the red marks. Run a new search to apply.`:'Mark 2–20 points along an inaccessible road; right-click or Finish. A 20 m buffer on each side, including nearby crossings, is excluded.';
 $('blocked-road-list').innerHTML=blockedRoads.map((road,index)=>`<div>Road ${index+1} · ${road.coordinates.length} points <button type="button" data-remove-road="${index}" ${searching?'disabled':''}>Remove</button></div>`).join('');
 document.querySelectorAll('[data-remove-road]').forEach(button=>button.onclick=()=>{
  if(searching)return;blockedRoads.splice(Number(button.dataset.removeRoad),1);clearDisplayedRoute();drawBlockedRoads();
 });
}
function previewBlockedRoad(cursor=null){
 if(!blockedRoadDrawing)return;
 if(blockedRoadPreview){map.removeLayer(blockedRoadPreview);blockedRoadPreview=null;}
 const points=[...blockedRoadDrawing,...(cursor?[cursor]:[])];
 if(points.length)blockedRoadPreview=L.polyline(points,{pane:'road-blocks',color:'#e44444',weight:5,dashArray:'7 5',interactive:false}).addTo(map);
 $('finish-blocked-road').disabled=blockedRoadDrawing.length<2;$('undo-blocked-road').disabled=!blockedRoadDrawing.length;
 $('blocked-road-status').textContent=`${blockedRoadDrawing.length} points. Click along the inaccessible road; right-click or Finish after at least 2 points.`;
}
$('draw-blocked-road').onclick=()=>{
 if(searching)return;
 if(blockedRoadDrawing){cancelBlockedRoadDrawing();return;}
 if(blockedRoads.length>=10){$('blocked-road-status').textContent='Up to 10 road sections. Remove one before adding another.';return;}
 cancelAreaDrawing();drawBlockedRoads();setMapPickTarget(null);blockedRoadDrawing=[];
 $('draw-blocked-road').textContent='Cancel marking';$('draw-blocked-road').setAttribute('aria-pressed','true');previewBlockedRoad();
};
$('undo-blocked-road').onclick=()=>{blockedRoadDrawing?.pop();previewBlockedRoad();};
$('finish-blocked-road').onclick=()=>{
 if(!blockedRoadDrawing||blockedRoadDrawing.length<2)return;
 const coordinates=blockedRoadDrawing.map(p=>[p.lng,p.lat]);
 if(coordinates.every(p=>p[0]===coordinates[0][0]&&p[1]===coordinates[0][1])){$('blocked-road-status').textContent='Choose different points along the road.';return;}
 blockedRoads.push({coordinates,buffer_meters:20});cancelBlockedRoadDrawing();clearDisplayedRoute();drawBlockedRoads();
 $('blocked-road-status').textContent=`${blockedRoads.length} blocked road sections. Routes must avoid the red marks. Run a new search to apply.`;
};
$('clear-blocked-roads').onclick=()=>{cancelBlockedRoadDrawing();blockedRoads=[];clearDisplayedRoute();drawBlockedRoads();$('blocked-road-status').textContent='No blocked road sections.';};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&blockedRoadDrawing)cancelBlockedRoadDrawing();});
function cancelAreaDrawing(){
 areaDrawing=null;
 if(areaPreview){map.removeLayer(areaPreview);areaPreview=null;}
 $('draw-route-polygon').setAttribute('aria-pressed','false');
 $('draw-route-polygon').textContent='Draw freeform area';
 $('finish-route-polygon').disabled=true;$('undo-route-polygon').disabled=true;
 $('draw-route-area').setAttribute('aria-pressed','false');
 $('draw-route-area').textContent='Draw box on map';
 $('map').classList.remove('drawing-route-area');
}
function finishRouteAreaChange(){
 updateTeam();
 $('clear-route-area').disabled=!allowedBounds;
 $('route-area-status').textContent=allowedBounds?'Area set. All route geometry must stay inside the amber outline. Draw again to replace it, or clear the limit.':'No area limit. Draw a box or freeform area to constrain the drive.';
 $('status').textContent='Route area changed. Run a new search to apply it.';
}
$('draw-route-area').onclick=()=>{
 cancelBlockedRoadDrawing();
 if(areaDrawing?.kind==='box'){cancelAreaDrawing();$('route-area-status').textContent='Drawing cancelled. The previous area, if any, is unchanged.';return;}
 cancelAreaDrawing();setMapPickTarget(null);areaDrawing={kind:'box',corner:null};
 $('draw-route-area').setAttribute('aria-pressed','true');
 $('draw-route-area').textContent='Cancel drawing';
 $('map').classList.add('drawing-route-area');
 $('route-area-status').textContent='Click or tap one corner on the map, then the opposite corner. Escape cancels.';
};
$('draw-route-polygon').onclick=()=>{
 cancelBlockedRoadDrawing();
 if(areaDrawing?.kind==='polygon'){cancelAreaDrawing();$('route-area-status').textContent='Drawing cancelled. The previous area is unchanged.';return;}
 cancelAreaDrawing();setMapPickTarget(null);areaDrawing={kind:'polygon',points:[]};
 $('draw-route-polygon').setAttribute('aria-pressed','true');
 $('draw-route-polygon').textContent='Cancel drawing';
 $('map').classList.add('drawing-route-area');
 $('route-area-status').textContent='Click or tap corners around your coverage area, then right-click or choose Finish shape. At least 3 corners; Escape cancels.';
};
function previewPolygon(hover=null){
 if(areaPreview){map.removeLayer(areaPreview);areaPreview=null;}
 const points=areaDrawing.points;
 if(points.length)areaPreview=L.polygon(hover?[...points,hover]:points,{color:'#f59e0b',weight:2,dashArray:'7 5',fillOpacity:.06,interactive:false}).addTo(map);
 $('finish-route-polygon').disabled=points.length<3||areaDrawing.busy;
 $('undo-route-polygon').disabled=!points.length||areaDrawing.busy;
}
$('undo-route-polygon').onclick=()=>{
 if(areaDrawing?.kind!=='polygon'||areaDrawing.busy)return;
 areaDrawing.points.pop();previewPolygon();
 $('route-area-status').textContent=`${areaDrawing.points.length} corners. Add corners, then right-click or choose Finish shape.`;
};
$('finish-route-polygon').onclick=async()=>{
 if(areaDrawing?.kind!=='polygon'||areaDrawing.points.length<3||areaDrawing.busy)return;
 const drawing=areaDrawing,ring=drawing.points.map(p=>[p.lng,p.lat]);ring.push([...ring[0]]);
 drawing.busy=true;previewPolygon();
 try{
  const response=await fetch('/api/validate-route-area',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allowed_bounds:{type:'Polygon',coordinates:[ring]}})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Could not validate this shape.');
  if(areaDrawing!==drawing)return;
  cancelAreaDrawing();allowedBounds=data.allowed_bounds;
  if(areaLayer)map.removeLayer(areaLayer);
  areaLayer=L.polygon(drawing.points,{color:'#f59e0b',weight:2,dashArray:'7 5',fillOpacity:.04,interactive:false}).addTo(map);
  finishRouteAreaChange();
 }catch(error){if(areaDrawing===drawing)$('route-area-status').textContent=`${error.message} Undo a corner or redraw the area.`;}
 finally{if(areaDrawing===drawing){drawing.busy=false;previewPolygon();}}
};
$('clear-route-area').onclick=()=>{
 cancelAreaDrawing();allowedBounds=null;
 if(areaLayer){map.removeLayer(areaLayer);areaLayer=null;}
 finishRouteAreaChange();
};
function handleAreaClick(latlng){
 if(!areaDrawing)return false;
 if(areaDrawing.kind==='polygon'){
  if(areaDrawing.busy)return true;
  if(areaDrawing.points.length>=100){$('route-area-status').textContent='Maximum 100 corners. Finish the shape or undo a corner.';return true;}
  if(areaDrawing.points.some(p=>p.equals(latlng,1e-10))){$('route-area-status').textContent='Right-click or choose Finish shape to close the polygon, or add a different corner.';return true;}
  areaDrawing.points.push(latlng);previewPolygon();
  $('route-area-status').textContent=`${areaDrawing.points.length} corners. ${areaDrawing.points.length>=3?'Right-click or choose Finish shape when ready.':'Add at least 3 corners.'}`;
  return true;
 }
 if(!areaDrawing.corner){
  areaDrawing.corner=latlng;
  $('route-area-status').textContent='Select the opposite corner. Escape cancels.';
  return true;
 }
 const bounds=L.latLngBounds(areaDrawing.corner,latlng);
 const box={west:bounds.getWest(),south:bounds.getSouth(),east:bounds.getEast(),north:bounds.getNorth()};
 if(box.west===box.east||box.south===box.north||box.west< -180||box.east>180||box.south< -90||box.north>90){
  $('route-area-status').textContent='Choose a different corner to create a non-empty box within the world map.';return true;
 }
 cancelAreaDrawing();allowedBounds=box;
 if(areaLayer)map.removeLayer(areaLayer);
 areaLayer=L.rectangle(bounds,{color:'#f59e0b',weight:2,dashArray:'7 5',fillOpacity:.04,interactive:false}).addTo(map);
 finishRouteAreaChange();return true;
}
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&areaDrawing){cancelAreaDrawing();$('route-area-status').textContent='Drawing cancelled. The previous area, if any, is unchanged.';}
});
function initCurrentLocation(){
 const control=L.control({position:'topleft'});
 let locationLayer=null;
 control.onAdd=()=>{
  const container=L.DomUtil.create('div','current-location-control');
  container.innerHTML='<button type="button" class="current-location-button" title="Zoom to your current location" aria-label="My location"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/></svg><span class="current-location-label"> My location</span></button><p class="current-location-status" role="status" aria-live="polite" hidden></p>';
  L.DomEvent.disableClickPropagation(container);
  L.DomEvent.disableScrollPropagation(container);
  const button=container.querySelector('button'),status=container.querySelector('p');
  const message=(text,state='info')=>{status.hidden=false;status.textContent=text;status.dataset.state=state;};
  button.onclick=()=>{
   if(!window.isSecureContext){message('Location needs HTTPS or localhost.');return;}
   if(!navigator.geolocation){message('This browser does not support device location.');return;}
   button.disabled=true;button.setAttribute('aria-busy','true');
   message('Finding your location…');
   const finish=()=>{button.disabled=false;button.removeAttribute('aria-busy');};
   navigator.geolocation.getCurrentPosition(position=>{
    finish();
    const {latitude,longitude,accuracy}=position.coords,point=[latitude,longitude];
    if(locationLayer)map.removeLayer(locationLayer);
    locationLayer=L.layerGroup([
     L.circle(point,{radius:accuracy,color:'#2463df',weight:1,fillOpacity:.08,interactive:false}),
     L.circleMarker(point,{radius:7,color:'#fff',weight:3,fillColor:'#2463df',fillOpacity:1,interactive:false})
    ]).addTo(map);
    map.setView(point,16);
    message(`Your location · accuracy about ${Math.round(accuracy).toLocaleString()} m`,'success');
   },error=>{
    finish();
    message(error.code===1?'Location access denied. Allow location in your browser settings and try again.':
            error.code===3?'Location lookup timed out. Try again.':'Your location is unavailable. Check device location settings and try again.');
   },{enableHighAccuracy:true,timeout:15000,maximumAge:30000});
  };
  return container;
 };
 control.addTo(map);
}
function updateCapturedVisibilityButton(){
 const button=$('toggle-captured-squares');
 button.textContent=capturedSquaresHidden?'Show captured squares':'Hide captured squares';
 button.setAttribute('aria-pressed',String(capturedSquaresHidden));
}
$('toggle-captured-squares').onclick=()=>{
 capturedSquaresHidden=!capturedSquaresHidden;
 try{localStorage.setItem('hide-captured-squares',String(capturedSquaresHidden));}catch{}
 updateCapturedVisibilityButton();drawBoard();
};
updateCapturedVisibilityButton();
function clearDisplayedRoute(){
 clearStopErrors();
 result=null;tripLabels=null;routeIndex=0;
 $('search-progress').hidden=true;
 $('navigation-modal')?.close();
 routeLayer?.clearLayers();targets?.clearLayers();bonusPlacesLayer?.clearLayers();
 $('comparison').hidden=true;$('comparison').replaceChildren();
 $('results').innerHTML=`<div class="empty"><h2>Awaiting orders, ${selectedTeam()}.</h2><p>Run a new search using your current start, destination, and route settings.</p></div>`;
 setPlanVisibility(false);renderFeedStatus();
}
function updateTeam(){
 const team=selectedTeam();
 document.querySelectorAll('[data-team-name]').forEach(label=>label.textContent=team);
 document.title=`${team} / MeshWars Route Planner`;
 document.documentElement.style.setProperty('--team-color',colors[team]);
 $('submit').textContent=`Plan ${team} operation →`;
 clearDisplayedRoute();updateSquareDarkness(true);
 if(boardAvailable)$('status').textContent=`Team ${team} selected. Run a new search to plan for this team.`;
}
const missionModes={
 offensive:{name:'Offensive Strike',description:'Prioritize vulnerable enemy squares. Unpainted ground and places are secondary.'},
 fortify:{name:'Fortify',description:'Reinforce weak friendly squares, especially along enemy borders. Reinforcement does not add square-held points.'},
 frontier:{name:'Frontier Patrol',description:'Favor unpainted squares adjoining your team’s territory. Unknown coverage remains exploration.'},
 flanking:{name:'Flanking Maneuver',description:'Scout wider loops and opportunities away from the fastest baseline, including backwards departures.'},
 special_ops:{name:'Special Operations',description:'Focus on eligible place bonuses. Requires enabled bonuses, positive weight and weekly points remaining.'},
 supply:{name:'Supply Run',description:'Favor productive routes with little extra driving. Priority is discounted as detour time increases.'},
};
function updateMissionMode(clear=true){
 const mode=missionModes[$('mission-mode').value];
 $('mission-mode-help').textContent=mode.description;
 if($('mission-mode').value==='special_ops'){
  $('include-places').checked=true;if(Number($('place-weight').value)<=0)$('place-weight').value='1';
 }
 if(clear&&map){clearDisplayedRoute();$('status').textContent=`${mode.name} selected. Run a new search for this objective.`;}
}
$('mission-mode').onchange=()=>updateMissionMode();
updateMissionMode(false);
$('team').onchange=updateTeam;
const driveStorageKey='meshwars-drives-v1';
let driveState={player:'',node:'',current:null,history:[]},driveConfigured=false,driveBusy=false;
try{
 const saved=JSON.parse(localStorage.getItem(driveStorageKey)||'null');
 if(saved&&typeof saved.player==='string'&&typeof saved.node==='string'&&Array.isArray(saved.history))driveState=saved;
}catch{}
$('drive-player').value=driveState.player;$('drive-node').value=driveState.node;
function saveDriveState(){
 try{localStorage.setItem(driveStorageKey,JSON.stringify(driveState));return true;}
 catch{$('drive-status').textContent='Browser storage unavailable. Keep this page open; session changes may not survive a reload.';return false;}
}
function renderDriveReport(){
 const session=driveState.current,report=session?.report;
 const active=!!session&&!session.ended_at;
 $('drive-start').disabled=driveBusy||active||!driveConfigured;
 $('drive-end').disabled=driveBusy||!active;
 $('drive-refresh').disabled=driveBusy||!session?.ended_at||!driveConfigured;
 $('drive-download').disabled=driveBusy||!report;
 $('drive-player').disabled=driveBusy||active;$('drive-node').disabled=driveBusy||active;
 $('drive-report').innerHTML=session?`<p>${escape(session.player)} · ${escape(session.node)}<br>Started ${escape(new Date(session.started_at*1000).toLocaleString())}${session.ended_at?`<br>Ended ${escape(new Date(session.ended_at*1000).toLocaleString())}`:' · In progress'}</p>`:'';
 if(report)$('drive-report').innerHTML+=`<strong>${report.unique_squares} unique squares captured</strong><p>${report.capture_events} capture events: ${report.unclaimed_capture_events} unclaimed, ${report.enemy_capture_events} taken from opponents.</p><p>Place points: unavailable<br>Defense points: unavailable<br>Total earned points: unavailable</p>${report.feed_limit_reached?'<p class="route-input-error">Feed limit reached: captures may be missing. Treat these counts as a lower bound.</p>':''}<p class="fine">Checked ${escape(new Date(report.checked_at*1000).toLocaleString())}. ${escape(report.notice)}</p><details><summary>Captured squares</summary><ul>${report.events.map(event=>`<li>${escape(event.cell_id)} · ${escape(new Date(event.ts*1000).toLocaleTimeString())} · ${escape(event.team)}${event.from_team?` from ${escape(event.from_team)}`:' from unclaimed'}</li>`).join('')}</ul></details>`;
 $('drive-history').innerHTML=driveState.history.length?driveState.history.map((entry,i)=>`<button type="button" data-drive-history="${i}" ${driveBusy||active?'disabled':''}>${escape(new Date(entry.started_at*1000).toLocaleString())} · ${escape(entry.player)} · ${entry.report?entry.report.unique_squares+' squares':'not checked'}</button>`).join(''):'No previous drives.';
 document.querySelectorAll('[data-drive-history]').forEach(button=>button.onclick=()=>{
  if(driveBusy||driveState.current&&!driveState.current.ended_at)return;
  const index=Number(button.dataset.driveHistory),entry=driveState.history.splice(index,1)[0];
  if(driveState.current)driveState.history.unshift(driveState.current);
  driveState.current=entry;saveDriveState();renderDriveReport();
 });
}
async function driveRequest(path,data){
 const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Drive request failed.');return result;
}
async function refreshDriveReport(){
 if(driveBusy||!driveState.current?.ended_at)return;
 driveBusy=true;renderDriveReport();$('drive-status').textContent='Checking recorded Meshtastic captures…';
 try{
  const {player,node,started_at,ended_at}=driveState.current;
  driveState.current.report=await driveRequest('/api/drives/report',{player,node,started_at,ended_at});
  $('drive-status').textContent='Report updated. Refresh later for delayed events; responses may be cached for 30 seconds.';
  saveDriveState();
 }catch(error){$('drive-status').textContent=error.message+' Session retained; you can retry.';}
 finally{driveBusy=false;renderDriveReport();}
}
$('drive-start').onclick=async()=>{
 if(driveBusy||driveState.current&&!driveState.current.ended_at)return;
 driveBusy=true;renderDriveReport();$('drive-status').textContent='Verifying your player and registered node…';
 try{
  const session=await driveRequest('/api/drives/start',{player:$('drive-player').value.trim(),node:$('drive-node').value.trim()});
  if(driveState.current)driveState.history.unshift(driveState.current);
  driveState.history=driveState.history.slice(0,20);driveState.current=session;
  driveState.player=session.player;driveState.node=session.node;
  $('drive-status').textContent='Drive started. End it when you arrive; no GPS recording or background browser operation is required.';
  saveDriveState();
 }catch(error){$('drive-status').textContent=error.message;}
 finally{driveBusy=false;renderDriveReport();}
};
$('drive-end').onclick=async()=>{
 if(driveBusy||!driveState.current||driveState.current.ended_at)return;
 driveState.current.ended_at=Date.now()/1000;saveDriveState();renderDriveReport();await refreshDriveReport();
};
$('drive-refresh').onclick=refreshDriveReport;
$('drive-download').onclick=()=>{
 const report=driveState.current?.report;if(!report)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download='meshwars-drive-report.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
async function initDriveTracker(){
 try{
  const response=await fetch('/api/drives/status');if(!response.ok)throw Error();
  const status=await response.json();driveConfigured=status.configured===true;
  if(!driveState.player)$('drive-player').value=status.player||'';
  if(!driveState.node)$('drive-node').value=status.node||'';
  $('drive-status').textContent=driveConfigured?(driveState.current&&!driveState.current.ended_at?'Drive in progress. End it when you arrive.':'Ready. Enter your registered player name and node ID.'): 'Set MESHWARS_API_KEY in the server environment and restart to enable drive reports.';
 }catch{$('drive-status').textContent='Drive integration unavailable. Existing sessions are retained.';}
 if(driveState.current&&!driveState.current.ended_at)$('sidebar-drive').open=true;
 renderDriveReport();
}
initDriveTracker();
const savedTripsKey='meshwars-saved-trips-v1';
let savedTrips=[];
try{const data=JSON.parse(localStorage.getItem(savedTripsKey)||'[]');if(Array.isArray(data))savedTrips=data.filter(t=>t&&typeof t.id==='string'&&typeof t.name==='string'&&Array.isArray(t.stops)&&t.stops.length>=2&&t.stops.length<=10).slice(0,30);}catch{}
function renderSavedTrips(selected=''){
 $('saved-trip').innerHTML='<option value="">Select a saved trip…</option>'+savedTrips.map(t=>`<option value="${escape(t.id)}">${escape(t.name)}</option>`).join('');
 $('saved-trip').value=selected;
 $('save-trip').textContent=selected?'Save changes':'Save trip';
 $('share-trip').disabled=searching||!selected;$('load-trip').disabled=searching||!selected;$('delete-trip').disabled=searching||!selected;
}
function persistTrips(next,selected,message){
 try{localStorage.setItem(savedTripsKey,JSON.stringify(next));savedTrips=next;renderSavedTrips(selected);$('saved-trip-status').textContent=message;}
 catch{$('saved-trip-status').textContent='Could not save changes. Browser storage may be full or disabled.';}
}
$('saved-trip').onchange=()=>{
 const trip=savedTrips.find(t=>t.id===$('saved-trip').value);
 $('trip-name').value=trip?.name||'';renderSavedTrips(trip?.id||'');
};
function currentTrip(){
 const ids=['start',...waypointIds(),'end'];
 return {team:selectedTeam(),mission_mode:$('mission-mode').value,stops:ids.map(id=>({text:$(id).value,selected:selectedLocations[id]||null})),area:allowedBounds,blocked_roads:structuredClone(blockedRoads),budget:$('budget').value,strategy:$('strategy').value,places:{enabled:$('include-places').checked,weight:$('place-weight').value,remaining:$('place-remaining').value,excluded:[...excludedPlaceIds],week:placeScoringWeek}};
}
$('save-trip').onclick=()=>{
 if(searching)return;
 const name=$('trip-name').value.trim();
 if(!name){$('saved-trip-status').textContent='Enter a name for this trip.';$('trip-name').focus();return;}
 const ids=['start',...waypointIds(),'end'];
 if(ids.some(id=>!$(id).value.trim())){$('saved-trip-status').textContent='Enter a start, destination, and each waypoint before saving.';return;}
 const existing=savedTrips.find(t=>t.id===$('saved-trip').value);
 if(!existing&&savedTrips.length>=30){$('saved-trip-status').textContent='Up to 30 trips can be saved. Delete a trip to make room.';return;}
 const trip={id:existing?.id||(globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`),name,...currentTrip()};
 persistTrips([...savedTrips.filter(t=>t.id!==trip.id),trip],trip.id,`Saved “${name}” in this browser. Saving again updates this trip.`);
};
$('delete-trip').onclick=()=>{
 if(searching)return;
 persistTrips(savedTrips.filter(t=>t.id!==$('saved-trip').value),'','Trip deleted.');$('trip-name').value='';
};
function applyTrip(trip){
 cancelAreaDrawing();cancelBlockedRoadDrawing();setMapPickTarget(null);clearAddressPreview();
 for(const id of ['start',...waypointIds(),'end'])delete selectedLocations[id];
 $('waypoints').replaceChildren();
 for(let i=0;i<trip.stops.length-2;i++)addWaypoint();
 ['start',...waypointIds(),'end'].forEach((id,i)=>{clearAddress(id);$(id).value=trip.stops[i].text;if(trip.stops[i].selected)selectedLocations[id]=trip.stops[i].selected;});
 $('team').value=colors[trip.team]?trip.team:'BLUE';
 $('mission-mode').value=missionModes[trip.mission_mode]?trip.mission_mode:'offensive';
 $('budget').value=trip.budget;$('strategy').value=trip.strategy;
 $('include-places').checked=trip.places.enabled;$('place-weight').value=trip.places.weight;$('place-remaining').value=trip.places.remaining;
 excludedPlaceIds=new Set(trip.places.excluded);placeScoringWeek=trip.places.week;
 updateMissionMode(false);
 $('place-settings-status').textContent='Restored place settings. Check weekly points remaining before searching; visited exclusions are checked against the scoring week.';
 blockedRoads=structuredClone(trip.blocked_roads||[]);drawBlockedRoads();
 allowedBounds=trip.area;
 if(areaLayer){map.removeLayer(areaLayer);areaLayer=null;}
 if(allowedBounds)areaLayer=(allowedBounds.type==='Polygon'?L.geoJSON(allowedBounds,{style:{color:'#f59e0b',weight:2,dashArray:'7 5',fillOpacity:.04,interactive:false}}):L.rectangle([[allowedBounds.south,allowedBounds.west],[allowedBounds.north,allowedBounds.east]],{color:'#f59e0b',weight:2,dashArray:'7 5',fillOpacity:.04,interactive:false})).addTo(map);
 finishRouteAreaChange();updateMarkers();
 const bounds=areaLayer?.getBounds()||(markers.getLayers().length?L.featureGroup(markers.getLayers()).getBounds():null);
 if(bounds?.isValid())map.fitBounds(bounds,{padding:[30,30],maxZoom:15});
 updateTeam();
}
$('load-trip').onclick=()=>{
 if(searching)return;
 const trip=savedTrips.find(t=>t.id===$('saved-trip').value);if(!trip)return;
 applyTrip(trip);
 $('saved-trip-status').textContent=`Loaded “${trip.name}”. Review weekly place settings and search for fresh routes.`;
};
// Share only an explicit mission schema; never browser sessions, credentials, or API data.
function sharedMission(value){
 const fail=()=>{throw Error('Invalid or unsupported mission link.');};
 const text=(v,max=500)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail();return v;};
 const number=(v,min,max)=>{if(!['number','string'].includes(typeof v)||v===''||!Number.isFinite(+v)||+v<min||+v>max)fail();return +v;};
 const point=p=>{if(!Array.isArray(p)||p.length!==2)fail();return [number(p[0],-180,180),number(p[1],-85,85)];};
 if(!value||typeof value!=='object')fail();
 const t=value;
 if(!Object.hasOwn(colors,t.team)||!Object.hasOwn(missionModes,t.mission_mode)||!['beam','greedy','compare'].includes(t.strategy)||!Array.isArray(t.stops)||t.stops.length<2||t.stops.length>10)fail();
 const stops=t.stops.map(stop=>({text:text(stop.text),selected:stop.selected?{label:text(stop.selected.label),coordinates:point(stop.selected.coordinates)}:null}));
 let area=null;
 if(t.area){
  if(t.area.type==='Polygon'){
   const ring=t.area.coordinates?.[0];if(!Array.isArray(ring)||ring.length<4||ring.length>101||t.area.coordinates.length!==1)fail();
   const coords=ring.map(point);if(JSON.stringify(coords[0])!==JSON.stringify(coords.at(-1)))fail();area={type:'Polygon',coordinates:[coords]};
  }else{
   area={west:number(t.area.west,-180,180),east:number(t.area.east,-180,180),south:number(t.area.south,-85,85),north:number(t.area.north,-85,85)};
   if(area.west>=area.east||area.south>=area.north)fail();
  }
 }
 if(!Array.isArray(t.blocked_roads||[])||(t.blocked_roads||[]).length>10)fail();
 const roads=(t.blocked_roads||[]).map(r=>{if(!Array.isArray(r.coordinates)||r.coordinates.length<2||r.coordinates.length>20)fail();return {coordinates:r.coordinates.map(point),buffer_meters:number(r.buffer_meters,5,100)};});
 const places=t.places;if(!places||typeof places.enabled!=='boolean'||!Array.isArray(places.excluded)||places.excluded.length>2000||!places.excluded.every(v=>Number.isSafeInteger(v)&&v>=0)||!(places.week===null||typeof places.week==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(places.week)))fail();
 return {name:text(t.name,80),team:t.team,mission_mode:t.mission_mode,stops,area,blocked_roads:roads,budget:number(t.budget,0,120),strategy:t.strategy,places:{enabled:places.enabled,weight:number(places.weight,0,5),remaining:number(places.remaining,0,100),excluded:places.excluded,week:places.week}};
}
async function encodeMission(trip){
 const bytes=new TextEncoder().encode(JSON.stringify({version:1,mission:sharedMission(trip)}));
 const compressed=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
 return btoa(String.fromCharCode(...compressed)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
async function decodeMission(encoded){
 if(encoded.length>64000||!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('Invalid mission link.');
 const bytes=Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
 const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
 let size=0,chunks=[];
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>100000){await reader.cancel();throw Error('Mission link is too large.');}chunks.push(value);}}finally{reader.releaseLock();}
 const data=JSON.parse(await new Blob(chunks).text());if(data.version!==1)throw Error('Unsupported mission link version.');return sharedMission(data.mission);
}
let pendingSharedMission=null;
function showMissionShare(title,message,link='',trip=null){
 pendingSharedMission=trip;$('mission-share-title').textContent=title;$('mission-share-message').textContent=message;
 $('mission-share-link').value=link;$('mission-share-link').hidden=!link;$('mission-share-copy').hidden=!link;
 document.querySelector('label[for="mission-share-link"]').hidden=!link;
 $('mission-share-import').hidden=!trip;$('mission-share-status').textContent='';$('mission-share-qr').replaceChildren();
 if(link)drawQr($('mission-share-qr'),link,'Scan to import this saved mission');
 $('mission-share-dialog').showModal();
}
$('share-trip').onclick=async()=>{
 const trip=savedTrips.find(t=>t.id===$('saved-trip').value);if(!trip||searching)return;
 try{
  const url=new URL(location.href);url.search='';url.hash='mission='+await encodeMission(trip);
  showMissionShare('Share mission',`Share “${trip.name}”. This link includes locations and mission settings. The recipient must be able to reach this planner address.`,url.href);
 }catch{$('saved-trip-status').textContent='Could not create the share link. This browser must support gzip compression streams.';}
};
$('mission-share-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('mission-share-link').value);$('mission-share-status').textContent='Link copied.';}catch{$('mission-share-link').select();$('mission-share-status').textContent='Select and copy the link above.';}};
$('mission-share-close').onclick=()=>$('mission-share-dialog').close();
$('mission-share-import').onclick=()=>{
 if(!pendingSharedMission||searching)return;
 if(savedTrips.length>=30){$('mission-share-status').textContent='Delete a saved mission first; this browser already has 30.';return;}
 const trip={...pendingSharedMission,id:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`};
 persistTrips([...savedTrips,trip],trip.id,`Imported “${trip.name}”. Load it, review weekly place settings, then search for fresh routes.`);
 if(savedTrips.some(t=>t.id===trip.id)){$('trip-name').value=trip.name;$('mission-share-dialog').close();$('sidebar-saved').scrollIntoView({block:'nearest'});}
 else $('mission-share-status').textContent='Could not save the mission. Browser storage may be full or disabled.';
};
async function receiveSharedMission(){
 if(!location.hash.startsWith('#mission='))return;
 const encoded=location.hash.slice(9);history.replaceState(null,'',location.pathname+location.search);
 try{const trip=await decodeMission(encoded);showMissionShare('Import shared mission',`Save “${trip.name}” (${missionModes[trip.mission_mode].name}, ${trip.stops.length} stops) as a new mission? Your current route stays unchanged. Review locations and weekly place settings before planning.`,'',trip);}
 catch{showMissionShare('Cannot import mission','This mission link is invalid, too large, or unsupported by this browser.');}
}
renderSavedTrips();
receiveSharedMission();
window.addEventListener('hashchange',receiveSharedMission);
const captureFilterHome=document.createComment('Capture age filter desktop location');
$('sidebar-capture').before(captureFilterHome);
const mobileMapFilter=window.matchMedia('(max-width: 800px)');
const standaloneMapFilter=window.matchMedia('(display-mode: standalone)');
function positionCaptureFilter(){
 const dock=$('map-filters'),filter=$('sidebar-capture');
 const installed=standaloneMapFilter.matches||navigator.standalone===true;
 document.documentElement.classList.toggle('standalone-app',installed);
 const aboveMap=mobileMapFilter.matches||installed;
 if(aboveMap){dock.append(filter);dock.hidden=false;}
 else{captureFilterHome.after(filter);dock.hidden=true;}
 document.querySelector('.workspace').dispatchEvent(new Event('routepanelchange'));
 if(map)map.invalidateSize({pan:false});
}
mobileMapFilter.addEventListener('change',positionCaptureFilter);
standaloneMapFilter.addEventListener('change',positionCaptureFilter);
positionCaptureFilter();
async function init(){
 startupState({stage:'Preparing your map…'});
 if(!window.L){
  $('status').textContent='Map library could not load. Check access to unpkg.com and reload.';$('submit').disabled=true;
  startupState({error:'The map could not load. Check your connection, then reload the app.'});return;
 }
 if(!window.RouteSearch){startupState({error:'Some app files could not load. Check your connection and reload.'});return;}
 map=L.map('map',{preferCanvas:true}).setView([40.6,-111.9],10);
 guardMapGestures();
 initCurrentLocation();
 const operationsLabel=L.control({position:'bottomleft'});
 operationsLabel.onAdd=()=>{
  const label=L.DomUtil.create('div','map-operations-label');
  label.innerHTML='<span aria-hidden="true">⌖</span><div>TACTICAL MAP<small>MESHTASTIC / TERRITORY</small></div>';
  return label;
 };
 operationsLabel.addTo(map);

 initDetailZoomControl();
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
 radioLayer=L.layerGroup().addTo(map);
 bonusPlacesLayer=L.layerGroup().addTo(map);
 updateTeam();
 map.on('movestart zoomstart',()=>{
  squareLookupMoving=true;
  if(squareLookupTimer){clearTimeout(squareLookupTimer);squareLookupTimer=null;}
  renderSquareLookupStatus();
 });
 map.on('moveend',()=>{squareLookupMoving=false;drawBoard();});
 map.on('moveend',drawRadioCoverage);
 map.on('contextmenu',e=>{
  if(blockedRoadDrawing){L.DomEvent.preventDefault(e.originalEvent);$('finish-blocked-road').click();return;}
  if(areaDrawing?.kind!=='polygon')return;
  L.DomEvent.preventDefault(e.originalEvent);
  if(areaDrawing.busy)return;
  if(areaDrawing.points.length<3){
   $('route-area-status').textContent='Add at least 3 corners before finishing. Right-click or choose Finish shape when ready.';
   return;
  }
  $('finish-route-polygon').click();
 });
 map.on('mousemove',e=>{
  if(blockedRoadDrawing){previewBlockedRoad(e.latlng);return;}
  if(areaDrawing?.kind==='polygon'){if(!areaDrawing.busy)previewPolygon(e.latlng);return;}
  if(!areaDrawing?.corner)return;
  const bounds=L.latLngBounds(areaDrawing.corner,e.latlng);
  if(areaPreview)areaPreview.setBounds(bounds);
  else areaPreview=L.rectangle(bounds,{color:'#f59e0b',weight:2,dashArray:'7 5',fillOpacity:.06,interactive:false}).addTo(map);
 });
 map.on('click',e=>{
  if(searching||Date.now()<suppressMapPickUntil)return;
  if(blockedRoadDrawing){
   if(blockedRoadDrawing.length>=20){$('blocked-road-status').textContent='Maximum 20 points. Finish this section or undo a point.';return;}
   blockedRoadDrawing.push(e.latlng);previewBlockedRoad();return;
  }
  if(handleAreaClick(e.latlng))return;
  if(mapPickTarget){
   const id=mapPickTarget;
   clearAddress(id);$(id).value=`${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
   setMapPickTarget(id==='start'?'end':null);
   clearDisplayedRoute();updateMarkers();
   $('status').textContent=id==='start'?'Start set. Tap the map once more to set Finish.':id==='end'?'Finish set. Map taps will no longer change your stops. Plan your route when ready.':`Waypoint set. Add more stops or find ${selectedTeam()} opportunities.`;
   return;
  }
 });
 ['start','end'].forEach(id=>$(id).addEventListener('change',updateMarkers));
 $('submit').disabled=true;
 startupState({stage:'Checking the latest territory data…'});
 const boardCheck=refreshBoard(true);
 void Promise.allSettled([refreshRadioCoverage(),refreshPlayers()]);
 let startupTimer;
 try{await Promise.race([boardCheck,new Promise(resolve=>{startupTimer=setTimeout(resolve,5000);})]);}
 finally{clearTimeout(startupTimer);}
 $('status').textContent=boardAvailable?'Choose start and destination to plan a drive.':'Waiting for capture data; automatic checks will continue.';
 startupState({ready:true,error:null});
 setInterval(()=>{refreshBoard();refreshRadioCoverage();refreshPlayers();},30*60*1000);
 // A recovered search must not open a modal over an unfinished startup screen.
 if(document.body.classList.contains('app-starting'))await new Promise(resolve=>window.addEventListener('app-visible',resolve,{once:true}));
 const pending=RouteSearch.pending();
 if(pending?.cancel_requested)void RouteSearch.cancelPending(pending);
 else if(pending){applyTrip(pending.context.trip);void planTrip(pending);}
}
const mobileSearch=window.matchMedia('(max-width: 800px)');
let progressHome=null;
function presentSearchProgress(active){
 const panel=$('search-progress'),dialog=$('search-dialog');
 if(!active)progressMinimized=false;
 if(active&&planningRoute&&mobileSearch.matches&&!progressMinimized){
  if(!dialog.open){
   progressHome=panel.parentElement;
   document.querySelector('.workspace').scrollIntoView({block:'start',behavior:'auto'});
   dialog.append(panel);panel.hidden=false;
   dialog.showModal();document.body.classList.add('search-modal-open');
  }
 }else{
  if(dialog.open)dialog.close();
  document.body.classList.remove('search-modal-open');
  if(progressHome){progressHome.append(panel);progressHome=null;}
 }
 panel.hidden=!active||progressMinimized;
 $('search-running-banner').hidden=!(active&&planningRoute&&progressMinimized);
 $('hide-search-progress').hidden=!(active&&planningRoute);
}
function minimizeSearchProgress(){
 if(!searching||!planningRoute)return;
 progressMinimized=true;presentSearchProgress(true);
 $('map').focus({preventScroll:true});
 document.querySelector('.workspace').scrollIntoView({block:'start',behavior:'auto'});
}
$('hide-search-progress').onclick=minimizeSearchProgress;
$('show-search-progress').onclick=()=>{if(searching){progressMinimized=false;presentSearchProgress(true);}};
mobileSearch.addEventListener('change',()=>presentSearchProgress(searching));
$('search-dialog').addEventListener('cancel',event=>{event.preventDefault();minimizeSearchProgress();});
function setSearching(active){
 searching=active;
 if($('clear-displayed-route'))$('clear-displayed-route').disabled=active;
 for(const id of ['save-trip','share-trip','saved-trip','trip-name'])$(id).disabled=active;
 $('share-trip').disabled=active||!$('saved-trip').value;$('load-trip').disabled=active||!$('saved-trip').value;$('delete-trip').disabled=active||!$('saved-trip').value;
 if(active){cancelAreaDrawing();cancelBlockedRoadDrawing();clearAddressPreview();setMapPickTarget(null);}
 $('clear-route-area').disabled=active||!allowedBounds;
 const progress=$('search-progress');
 if(active){progress.dataset.meshState='searching';progress.querySelector('.mesh-caption').textContent='Recon in progress';}
 else{
  const complete=$('progress-bar').value===100;
  progress.dataset.meshState=complete?'complete':'idle';
  progress.querySelector('.mesh-caption').textContent=complete?'Recon complete':'Standing by';
 }
 for(const id of ['mission-mode','draw-blocked-road','clear-blocked-roads','include-places','place-weight','place-remaining','draw-route-area','draw-route-polygon','team','start','end','start-lookup','end-lookup','start-map','end-map','swap-endpoints','budget','strategy','submit','print'])$(id).disabled=active;
 $('submit').textContent=active ? 'Scouting routes…' : `Plan ${selectedTeam()} operation →`;
 $('submit').disabled=active||!boardAvailable;
 $('results').setAttribute('aria-busy',String(active));
 document.querySelectorAll('.address-options button, #comparison button, #waypoints input, #waypoints button').forEach(button=>button.disabled=active);
 drawBlockedRoads();
 refreshWaypointLabels();
 presentSearchProgress(active);
}
function clearStopErrors(){
 $('route-input-error').hidden=true;$('route-input-error').textContent='';
 for(const id of ['start',...waypointIds(),'end'])$(id).removeAttribute('aria-invalid');
}
$('planner').addEventListener('input',clearStopErrors);
async function validateTripArea(start,end,waypoints,signal){
 if(!allowedBounds&&!blockedRoads.length)return;
 const response=await fetch('/api/validate-route-area',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({start,end,waypoints,allowed_bounds:allowedBounds,blocked_roads:blockedRoads})});
 const data=await response.json();if(response.ok)return;
 const message=data.error||'Could not validate the trip area.';
 $('route-input-error').textContent=message;$('route-input-error').hidden=false;
 const ids=(data.outside_stops||data.blocked_stops||[]).map(key=>key==='start'||key==='end'?key:waypointIds()[Number(key.slice(1))-1]).filter(Boolean);
 ids.forEach(id=>$(id).setAttribute('aria-invalid','true'));
 const error=Error(message);error.boundaryValidation=true;
 // Finish re-enabling the inputs before returning focus to the invalid stop.
 error.invalidStop=ids[0];throw error;
}
async function planTrip(resuming=null){
 if(searching)return;
 let timer=null,invalidStop=null,completed=false,failed=false;
 clearStopErrors();
 try{
  planningRoute=true;progressMinimized=false;searchController=new AbortController();setSearching(true);updateMarkers();
  $('search-running-label').textContent='Search running…';
  $('search-progress').hidden=false;$('progress-bar').value=0;$('progress-percent').textContent='0%';
  $('progress-stage').textContent='Connecting to planner…';
  $('status').textContent='Search in progress. You can cancel at any time.';
  const started=resuming?.started_at||Date.now();let lastUpdate=Date.now();
  const updateTime=()=>{
   const seconds=Math.floor((Date.now()-started)/1000),quiet=Math.floor((Date.now()-lastUpdate)/1000);
   $('progress-time').textContent=`Elapsed ${Math.floor(seconds/60)}m ${seconds%60}s · Last update ${quiet}s ago${quiet>=10?' · Waiting for routing provider…':''}`;
  };
  updateTime();timer=setInterval(updateTime,1000);
  let start,end,requiredWaypoints;
  if(!resuming){
   $('progress-stage').textContent='Checking start and destination…';
   start=await resolveLocation('start',searchController.signal);
   requiredWaypoints=[];
   for(const id of waypointIds())requiredWaypoints.push(await resolveLocation(id,searchController.signal));
   end=await resolveLocation('end',searchController.signal);
   if(!start || !end || requiredWaypoints.some(point=>!point)){
    $('status').textContent=`Choose the matching addresses below the inputs, then find ${selectedTeam()} opportunities again.`;
    $('progress-stage').textContent='Waiting for address selection';return;
   }
   $('progress-stage').textContent='Checking stops against the drawn area…';
   await validateTripArea(start,end,requiredWaypoints,searchController.signal);
   updateMarkers();
  }
  const requestedLabels=resuming?.context.labels||{start:$('start').value,end:$('end').value,waypoints:waypointIds().map(id=>$(id).value)};
  const payload=resuming?.payload||{place_options:{enabled:$('include-places').checked,weight:Number($('place-weight').value),remaining:Number($('place-remaining').value),excluded:[...excludedPlaceIds],week:placeScoringWeek},allowed_bounds:allowedBounds,blocked_roads:blockedRoads,mission_mode:$('mission-mode').value,team:selectedTeam(),start,end,waypoints:requiredWaypoints,detour_minutes:Number($('budget').value),strategy:$('strategy').value};
  const onProgress=event=>{
   lastUpdate=Date.now();$('progress-bar').value=event.percent;
   $('progress-percent').textContent=`${Math.floor(event.percent)}%`;
   $('progress-stage').textContent=event.message;updateTime();
   $('search-running-label').textContent=event.message.startsWith('Connection interrupted')?'Search retained · reconnecting…':`Search running · ${Math.floor(event.percent)}%`;
   $('search-running-label').title=event.message;
  };
  const data=await (resuming?RouteSearch.resume(resuming,onProgress,searchController.signal):RouteSearch.start(payload,{labels:requestedLabels,trip:currentTrip()},onProgress,searchController.signal));
  result=data;tripLabels=requestedLabels;renderFeedStatus();
  if(data.places?.week_start){
   placeScoringWeek=data.places.week_start;excludedPlaceIds=new Set(data.places.excluded||[]);
   $('place-remaining').value=String(data.places.remaining);
   $('place-settings-status').textContent=data.places.available?`Week ${placeScoringWeek} · ${data.places.places.length} active places loaded. ${data.places.truncated?'Source list is incomplete. ':''}Bonuses remain estimates.`:(data.places.error||'Places unavailable; territory-only search.');
  }
  $('progress-bar').value=100;$('progress-percent').textContent='100%';$('progress-stage').textContent='Search complete';
  showComparison();showActiveResult();
  completed=true;
  $('status').textContent=data.no_opportunities?(data.message||'No opportunities found for this mission within the budget.'):`${data.strategy==='beam'?'Beam':'Greedy'}: ${data.routes.length} route options within budget. ${data.routing_metrics?.workers||1} routing workers; average request ${data.routing_metrics?.mean_request_seconds||0}s (including queue/rate-limit waits). ${data.failed_candidates ? `${data.failed_candidates} detour requests failed. ` : ''}${data.mission_mode==='fortify'?'Amber outlines show reinforcement targets; reinforcement adds no immediate square-held points.':'Green outlines show mission targets; capture is not guaranteed.'}`;
 }catch(error){
  const cancelled=error.name==='AbortError';
  invalidStop=error.invalidStop;failed=!cancelled;
  if(failed){$('route-input-error').textContent=error.message||'Route search failed. Please try again.';$('route-input-error').hidden=false;}
  $('status').textContent=cancelled?'Search cancelled. You can change the settings and try again.':error.message;
  $('progress-stage').textContent=cancelled?'Search cancelled':error.boundaryValidation?'Trip constraints need attention':'Search failed';
 }finally{
  if(timer)clearInterval(timer);
  searchController=null;setSearching(false);planningRoute=false;
  if(completed&&mobileSearch.matches)document.querySelector('.workspace').scrollIntoView({block:'start',behavior:'auto'});
  if(invalidStop){revealSidebarControl($(invalidStop));$(invalidStop)?.focus();}
  else if(failed){revealSidebarControl($('route-input-error'));$('route-input-error').focus();$('route-input-error').scrollIntoView({block:'center',behavior:'auto'});}
 }
}
$('planner').addEventListener('submit',event=>{event.preventDefault();void planTrip();});
$('print').onclick=()=>window.print();
init().catch(()=>{
 $('status').textContent='The planner could not start. Please reload the app.';
 startupState({error:'The planner could not start. Check your connection and reload the app.'});
});
