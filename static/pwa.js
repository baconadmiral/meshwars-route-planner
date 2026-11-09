'use strict';
(()=>{
 if(!window.isSecureContext||!('serviceWorker' in navigator))return;
 // Cache only an offline notice. Live pages, APIs and map tiles stay network-only.
 navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>{});
 const buttons=[...document.querySelectorAll('[data-install-app]')];
 const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 let installPrompt=null;
 window.addEventListener('beforeinstallprompt',event=>{
  if(standalone())return;
  event.preventDefault();installPrompt=event;
  buttons.forEach(button=>{button.hidden=false;});
 });
 buttons.forEach(button=>button.addEventListener('click',async()=>{
  if(!installPrompt)return;
  const prompt=installPrompt;installPrompt=null;
  buttons.forEach(control=>{control.hidden=true;});
  try{await prompt.prompt();await prompt.userChoice;}catch{}
 }));
 window.addEventListener('appinstalled',()=>{
  installPrompt=null;buttons.forEach(button=>{button.hidden=true;});
 });
})();
