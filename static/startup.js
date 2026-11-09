'use strict';
// Loaded asynchronously: the inline splash remains visible even if a CDN stalls.
(()=>{
 const screen=document.getElementById('app-loading');
 if(!screen)return;
 let complete=false;
 const main=document.querySelector('main');
 main?.setAttribute('aria-busy','true');
 function showError(message){
  document.getElementById('startup-title').textContent='Taking a little longer…';
  document.getElementById('startup-message').textContent=message;
  screen.classList.add('startup-delayed');
 }
 const timer=setTimeout(()=>{
  if(!complete&&!screen.classList.contains('startup-delayed'))showError('Check your connection, or reload the app to try again. We’re still waiting for everything to load.');
 },12000);
 function render(){
  if(complete)return;
  const state=window.appStartupState||{};
  const styles=[...document.querySelectorAll('[data-startup-style]')];
  if(state.error){showError(state.error);return;}
  if(styles.some(link=>link.dataset.startupFailed==='true')){
   showError('The app’s appearance could not load. Check your connection and reload.');return;
  }
  if(state.ready&&styles.every(link=>link.dataset.startupLoaded==='true')){
   complete=true;clearTimeout(timer);
   screen.hidden=true;document.body.classList.remove('app-starting');
   main?.removeAttribute('aria-busy');
   requestAnimationFrame(()=>window.dispatchEvent(new Event('app-visible')));
   return;
  }
  if(state.stage)document.getElementById('startup-message').textContent=state.stage;
 }
 window.addEventListener('app-startup',render);
 render();
})();
