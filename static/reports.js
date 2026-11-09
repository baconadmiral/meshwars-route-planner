'use strict';
const $=id=>document.getElementById(id);
const colors={BLUE:'#1656e8',RED:'#e44444',GREEN:'#2e9e65',PURPLE:'#8858be',YELLOW:'#d2a716',ORANGE:'#e88032',PINK:'#db6aa5'};
let report=null;
const selected=new Set(Object.keys(colors));
const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
let explicitTheme=null;
try{const saved=localStorage.getItem('blue-theme');if(saved==='dark'||saved==='light')explicitTheme=saved;}catch{}
function applyTheme(){
 const dark=(explicitTheme||(systemTheme.matches?'dark':'light'))==='dark';
 document.documentElement.dataset.theme=dark?'dark':'light';
 $('theme-toggle').textContent=dark?'Light mode':'Dark mode';
 $('theme-toggle').setAttribute('aria-pressed',String(dark));
}
$('theme-toggle').onclick=()=>{
 explicitTheme=document.documentElement.dataset.theme==='dark'?'light':'dark';
 try{localStorage.setItem('blue-theme',explicitTheme);}catch{}
 applyTheme();
};
systemTheme.addEventListener('change',applyTheme);applyTheme();
function textElement(tag,text){const element=document.createElement(tag);element.textContent=text;return element;}
function svgElement(tag,attrs={},text=null){
 const element=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [key,value] of Object.entries(attrs))element.setAttribute(key,String(value));
 if(text!==null)element.textContent=text;
 return element;
}
function drawChart(){
 const container=$('report-chart');container.replaceChildren();
 $('chart-point').textContent='';
 const teams=report.teams.filter(team=>selected.has(team));
 if(!teams.length){container.append(textElement('p','Select a team to display its daily points.'));return;}
 const width=1000,height=350,left=55,right=20,top=25,bottom=55;
 const max=Math.max(1,...report.days.flatMap(day=>teams.map(team=>day.teams[team])));
 const ceiling=Math.max(4,Math.ceil(max/4)*4);
 const x=index=>left+index*(width-left-right)/29;
 const y=value=>height-bottom-value*(height-top-bottom)/ceiling;
 const svg=svgElement('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-labelledby':'daily-chart-title daily-chart-desc'});
 svg.append(svgElement('title',{id:'daily-chart-title'},'Daily territory points by team'));
 svg.append(svgElement('desc',{id:'daily-chart-desc'},'Thirty UTC dates, including today. Counts reflect currently held squares. Full values are in the daily breakdown table.'));
 for(let i=0;i<=4;i++){
  const value=ceiling*i/4;
  svg.append(svgElement('line',{x1:left,x2:width-right,y1:y(value),y2:y(value),class:'report-grid'}));
  svg.append(svgElement('text',{x:left-10,y:y(value)+4,'text-anchor':'end',class:'report-axis'},value.toLocaleString()));
 }
 for(const i of [0,5,10,15,20,25,29])svg.append(svgElement('text',{x:x(i),y:height-bottom+25,'text-anchor':i===29?'end':i===0?'start':'middle',class:'report-axis'},report.days[i].date.slice(5)));
 svg.append(svgElement('text',{x:left,y:height-5,class:'report-axis'},'Capture date (UTC)'));
 for(const team of teams){
  const points=report.days.map((day,i)=>`${x(i)},${y(day.teams[team])}`).join(' ');
  svg.append(svgElement('polyline',{points,fill:'none',stroke:colors[team],'stroke-width':2}));
  report.days.forEach((day,i)=>{
   const label=`${team} · ${day.date} UTC · ${day.teams[team]} territory points`;
   const point=svgElement('circle',{cx:x(i),cy:y(day.teams[team]),r:3.5,fill:colors[team],tabindex:0,class:'report-point','aria-label':label});
   point.addEventListener('focus',()=>{$('chart-point').textContent=label;});
   point.addEventListener('mouseenter',()=>{$('chart-point').textContent=label;});
   point.append(svgElement('title',{},label));svg.append(point);
  });
 }
 container.append(svg);
}
function renderReport(){
 $('report-period').textContent=`${report.start_date} – ${report.end_date} · UTC calendar days · today so far`;
 $('report-total').textContent=report.total.toLocaleString();
 const peak=report.days.reduce((best,day)=>day.total>best.total?day:best);
 $('report-peak').textContent=report.total?`${peak.total.toLocaleString()} · ${peak.date}`:'0 · no captures in window';
 $('report-missing').textContent=report.missing_capture_time_count.toLocaleString();
 const updated=report.board_updated_at?new Date(report.board_updated_at*1000).toLocaleString():'unknown';
 $('report-status').textContent=`${report.stale?'Cached/stale board. ':''}Board checked: ${updated}. ${report.outside_window_count.toLocaleString()} squares have capture dates before this window. ${report.unknown_team_count.toLocaleString()} squares have unsupported owners and are excluded.${report.error?' Feed warning: '+report.error:''}`;
 const head=document.createElement('tr');
 for(const label of ['Date (UTC)',...report.teams,'Total']){const cell=textElement('th',label);cell.scope='col';head.append(cell);}
 $('report-table').querySelector('thead').replaceChildren(head);
 const body=$('report-table').querySelector('tbody');body.replaceChildren();
 for(const day of report.days){
  const row=document.createElement('tr'),date=textElement('th',day.date+(day.date===report.end_date?' · today':''));date.scope='row';row.append(date);
  for(const value of [...report.teams.map(team=>day.teams[team]),day.total])row.append(textElement('td',value.toLocaleString()));
  body.append(row);
 }
 $('report-content').hidden=false;drawChart();
}
for(const [team,color] of Object.entries(colors)){
 const label=document.createElement('label');label.style.setProperty('--team-color',color);
 const input=document.createElement('input');input.type='checkbox';input.checked=true;
 input.onchange=()=>{if(input.checked)selected.add(team);else selected.delete(team);if(report)drawChart();};
 const swatch=document.createElement('span');swatch.className='report-swatch';swatch.setAttribute('aria-hidden','true');
 label.append(input,swatch,document.createTextNode(team));$('report-teams').append(label);
}
async function loadReport(){
 $('refresh-report').disabled=true;$('report-status').textContent='Loading report…';
 try{
  const response=await fetch('/api/reports/territory',{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Report request failed. Please retry.');
  const data=await response.json();
  if(!data.available){report=null;$('report-content').hidden=true;$('report-status').textContent=data.error||'Waiting for board data. Refresh the report after the board becomes available.';return;}
  report=data;renderReport();
 }catch{
  $('report-status').textContent=report?'Could not refresh. The previous report remains displayed. Try again.':'Could not load the report. Try again.';
 }finally{$('refresh-report').disabled=false;}
}
$('refresh-report').onclick=loadReport;
window.appStartupState={stage:'Preparing your territory report…'};
window.dispatchEvent(new Event('app-startup'));
let startupTimer;
Promise.race([loadReport(),new Promise(resolve=>{startupTimer=setTimeout(resolve,5000);})]).finally(()=>{
 clearTimeout(startupTimer);
 window.appStartupState={ready:true};window.dispatchEvent(new Event('app-startup'));
});
