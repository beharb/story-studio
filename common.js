/* Shared by the Fotolajm and Video Lajm editors: categories, text wrapping, dragging/pinching the
   photo or video into place, and saving on phones (share sheet → Photos) and computers (download). */

/* iOS 15 and older have no roundRect on canvas */
if(!CanvasRenderingContext2D.prototype.roundRect)CanvasRenderingContext2D.prototype.roundRect=function(x,y,w,h,r){
  r=Math.min(+r||0,w/2,h/2);this.moveTo(x+r,y);this.arcTo(x+w,y,x+w,y+h,r);this.arcTo(x+w,y+h,x,y+h,r);
  this.arcTo(x,y+h,x,y,r);this.arcTo(x,y,x+w,y,r);this.closePath()};

const $=id=>document.getElementById(id);
const PHONE=matchMedia("(pointer:coarse)").matches;
/* Instagram / Facebook / TikTok in-app browsers can't save files */
const INAPP=/Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|Line\//i.test(navigator.userAgent);
const clamp=v=>Math.max(0,Math.min(1,v));

function store(k,v){try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}}
function load(k){try{return localStorage.getItem(k)}catch(e){return null}}

/* each category owns one colour (tag box, accent bar); ink = text colour on the box */
const CATS={
  lajme:{name:"Lajme",color:"#cc2424",ink:"#ffffff",subs:["LAJM I FUNDIT","KOSOVË","SHQIPËRI","MAQEDONI","BOTË","EKSKLUZIVE","OPINION"]},
  sport:{name:"Sport",color:"#fadb3c",ink:"#ffffff",subs:["SPORT"]},
  kulture:{name:"Kulturë",color:"#328dd1",ink:"#ffffff",subs:["KULTURË"]}
};
const DAYS=["E DIEL","E HËNË","E MARTË","E MËRKURË","E ENJTE","E PREMTE","E SHTUNË"];
const MONTHS=["JANAR","SHKURT","MARS","PRILL","MAJ","QERSHOR","KORRIK","GUSHT","SHTATOR","TETOR","NËNTOR","DHJETOR"];

function wrapText(ctx,text,maxW){
  const out=[];
  text.split(/\n/).forEach(par=>{
    const words=par.trim().split(/\s+/).filter(Boolean);let line="";
    words.forEach(w=>{const t=line?line+" "+w:w;
      if(ctx.measureText(t).width>maxW&&line){out.push(line);line=w}else line=t});
    if(line)out.push(line);
  });
  return out;
}

/* category chips + rubrika chips; S.cat holds the category, the tag input holds the rubrika */
function setupCats(S,catBox,subBox,tag,onChange){
  const renderSubs=()=>{subBox.innerHTML="";CATS[S.cat].subs.forEach(t=>{const b=document.createElement("button");b.type="button";b.className="chip";b.textContent=t;
    b.onclick=()=>{tag.value=t;onChange()};subBox.appendChild(b)})};
  Object.entries(CATS).forEach(([k,c])=>{const b=document.createElement("button");b.type="button";b.className="chip";b.textContent=c.name;b.dataset.k=k;
    b.onclick=()=>{S.cat=k;renderSubs();tag.value=c.subs[0];S.color=c.color;onChange()};catBox.appendChild(b)});
  renderSubs();
  return renderSubs;
}
function paintCats(S,catBox,subBox,tag){
  const cur=tag.value.trim().toUpperCase();
  [...subBox.children].forEach(c=>c.setAttribute("aria-pressed",c.textContent===cur));
  const col=S.color||CATS[S.cat].color;
  document.documentElement.style.setProperty("--red",col);
  document.documentElement.style.setProperty("--red-ink",CATS[S.cat].ink);
  [...catBox.children].forEach(c=>{const on=c.dataset.k===S.cat,k=CATS[c.dataset.k];c.setAttribute("aria-pressed",on);
    c.style.background=on?k.color:"";c.style.borderColor=on?k.color:"";c.style.color=on?k.ink:""});
}

/* cover-fit a w×h source into the W×H frame at zoom z; S.ox/S.oy are clamped so no edge shows */
function coverRect(S,w,h,W,H,z){
  const s=Math.max(W/w,H/h)*z,dw=w*s,dh=h*s,mx=(dw-W)/2,my=(dh-H)/2;
  S.ox=Math.max(-mx,Math.min(mx,S.ox));S.oy=Math.max(-my,Math.min(my,S.oy));
  return {x:(W-dw)/2+S.ox,y:(H-dh)/2+S.oy,w:dw,h:dh};
}

/* one finger (or the mouse) drags the media, two fingers pinch the zoom slider */
function setupFraming(cv,S,W,zoom,canMove,redraw){
  let drag=null,pinch=null;const pts=new Map();
  const gap=()=>{const [a,b]=[...pts.values()];return Math.hypot(a.x-b.x,a.y-b.y)||1};
  cv.addEventListener("pointerdown",e=>{
    if(!canMove())return;
    cv.setPointerCapture(e.pointerId);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pts.size===2){drag=null;pinch={d:gap(),z:+zoom.value}}
    else if(pts.size===1){drag={x:e.clientX,y:e.clientY,ox:S.ox,oy:S.oy};cv.classList.add("drag")}
  });
  cv.addEventListener("pointermove",e=>{
    if(!pts.has(e.pointerId))return;
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pinch&&pts.size>=2){zoom.value=Math.round(Math.max(+zoom.min,Math.min(+zoom.max,pinch.z*gap()/pinch.d)));zoom.dispatchEvent(new Event("input",{bubbles:true}));return}
    if(!drag)return;
    const k=W/cv.getBoundingClientRect().width;S.ox=drag.ox+(e.clientX-drag.x)*k;S.oy=drag.oy+(e.clientY-drag.y)*k;redraw();
  });
  /* pointercancel too: iOS cancels touches on system gestures */
  const end=e=>{pts.delete(e.pointerId);if(pts.size<2)pinch=null;if(!pts.size){drag=null;cv.classList.remove("drag")}};
  cv.addEventListener("pointerup",end);cv.addEventListener("pointercancel",end);
}

function slugOf(text){
  return (text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40))||"albanianpost";
}

/* on phones the share sheet is the way into Photos ("Save Image" / "Save Video"); a plain download lands in Files */
function canShareFile(file){try{return !!(navigator.canShare&&navigator.canShare({files:[file]}))}catch(e){return false}}
async function shareFile(file){
  const st=$("status");
  try{await navigator.share({files:[file]});st.textContent="U ruajt: "+file.name;return true}
  catch(err){if(err?.name==="AbortError"){st.textContent="Ruajtja u anulua.";return true}return false}
}
async function saveFile(blob,ext,name){
  const st=$("status");$("result").hidden=true;
  const file=new File([blob],`${name}.${ext}`,{type:blob.type});
  const share=PHONE&&canShareFile(file),isImg=ext==="png";
  if(share){
    /* the share sheet needs a fresh tap; after a recording that tap has expired, so offer a button */
    if(await shareFile(file))return;
    st.textContent="Shtyp “Ruaj në telefon” më poshtë.";
  }else{
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=file.name;a.click();
    st.textContent="U ruajt: "+file.name;
    if(!PHONE)return;
  }
  const url=URL.createObjectURL(blob);
  $("resultImg").hidden=!isImg;$("resultVid").hidden=isImg;
  if(isImg)$("resultImg").src=url;else{$("resultVid").src=url;$("resultVid").play().catch(()=>{})}
  $("shareBtn").hidden=!share;$("shareBtn").onclick=()=>shareFile(file);
  $("resultHint").hidden=share&&!isImg;
  $("result").hidden=false;
}

/* MP4 where the browser can record it (Safari, new Chrome), WebM otherwise */
function pickRecType(withAudio,skip=[]){
  const types=withAudio
    ?["video/mp4;codecs=avc1.42E01F,mp4a.40.2","video/mp4;codecs=avc1,mp4a","video/mp4","video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"]
    :["video/mp4;codecs=avc1.42E01F","video/mp4;codecs=avc1","video/mp4","video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm"];
  return types.find(m=>!skip.includes(m)&&window.MediaRecorder&&MediaRecorder.isTypeSupported(m));
}

/* shown until the page's script runs: file previews (Files, AirDrop, WhatsApp, Mail) don't run JavaScript */
function scriptsRunning(){const n=$("nojs");if(n)n.remove();$("inapp").hidden=!INAPP}

/* offline copy of the app (needs https; localhost for testing) */
if("serviceWorker" in navigator&&(location.protocol==="https:"||location.hostname==="localhost"))
  navigator.serviceWorker.register("sw.js").catch(()=>{});
