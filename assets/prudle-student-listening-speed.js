/* Prudle Student Listening Controls — optional integration into the existing student page.
   Include as <script defer src=".../prudle-student-listening-speed.js"></script> in the student's actual exam HTML.
   No network calls. Adjusts playbackRate of existing audio tags without changing grading. */
(function(){
 'use strict';
 const SPEEDS=[0.65,0.75,0.85,1,1.25,1.5];
 function bind(audio){
  if(audio.dataset.prudleSpeedBound==='1')return;
  audio.dataset.prudleSpeedBound='1';
  audio.preservesPitch=true;
  const wrap=document.createElement('label');
  wrap.className='prudle-student-playback-speed';
  wrap.style.cssText='display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:8px 0 16px;font:700 14px Tajawal,Arial,sans-serif;color:#164478;';
  wrap.textContent='🎧 سرعة الاستماع:';
  const select=document.createElement('select');
  select.setAttribute('aria-label','سرعة تشغيل الصوت');
  select.style.cssText='max-width:135px;min-height:42px;padding:7px 12px;border:1px solid #adc6e5;border-radius:10px;color:#164478;background:#fff;';
  for(const s of SPEEDS){const opt=document.createElement('option');opt.value=String(s);opt.textContent=s.toFixed(2)+'×';opt.selected=s===1;select.append(opt)}
  select.addEventListener('change',()=>{audio.playbackRate=Number(select.value)||1;audio.preservesPitch=true});
  audio.addEventListener('loadedmetadata',()=>{audio.playbackRate=Number(select.value)||1});
  wrap.append(select);audio.insertAdjacentElement('afterend',wrap);
 }
 function scan(root=document){
  if(root.nodeType===1&&root.matches('audio[controls]'))bind(root);
  root.querySelectorAll?.('audio[controls]').forEach(bind);
 }
 function start(){scan();const observer=new MutationObserver(mutations=>{
  for(const mutation of mutations)for(const node of mutation.addedNodes){if(node.nodeType===1)scan(node)}
 });observer.observe(document.body,{childList:true,subtree:true});}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
