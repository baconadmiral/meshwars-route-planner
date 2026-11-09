// Render the existing shield/radio motif at the required install icon sizes.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const directory=path.resolve(__dirname,'../../static/icons');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const [size,name] of [[192,'icon-192.png'],[512,'icon-512.png'],[180,'apple-touch-icon.png']]){
   const page=await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
   await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>${fs.readFileSync(path.join(directory,'icon.svg'),'utf8')}`);
   await page.screenshot({path:path.join(directory,name)});await page.close();
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
