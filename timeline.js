/* Video Lajm editor: a small Premiere-style timeline.
   The graphics layers (the title, the name card…) sit on their own tracks above; V1 holds the clips (cut from any number
   of uploaded videos or photos), A1 their sound.
   Clips sit end to end, so deleting one closes the gap. Tools: select (V), razor (C), cut at the playhead (⌘K),
   delete, insert at the playhead, drag to reorder, drag an edge to trim, undo/redo, zoom.
   Playback uses two <video> elements in turn (A/B roll): while one plays, the other is already parked on the next
   clip's first frame, so cuts are instant in the recording. */
function createTimeline(o){
  const FPS=30,MIN=1/FPS*3,IMG_DUR=5,IMG_MAX=600,PAD=12;
  const media=new Map();let mid=0,cid=0;
  let clips=[],sel=new Set(),time=0,pps=40,tool="select",playing=false,locked=false,stopFlag=false;
  const undo=[],redo=[];
  const mkVid=()=>{const v=document.createElement("video");v.setAttribute("playsinline","");v.playsInline=true;v.muted=true;v.preload="auto";
    v.className="tl-dec";document.body.appendChild(v);v._m=null;return v};
  const els=[mkVid(),mkVid()];
  let cur=null,prev=null;                     // what is on screen: {c,m,v?}; prev = last video element, held during a switch

  /* ---------- sequence ---------- */
  const len=c=>c.out-c.in;
  const total=()=>clips.reduce((s,c)=>s+len(c),0);
  const starts=()=>{let s=0;return clips.map(c=>{const a=s;s+=len(c);return a})};
  function at(t){
    let s=0;
    for(let i=0;i<clips.length;i++){const l=len(clips[i]);if(t<s+l-1e-6||i===clips.length-1)return {i,off:Math.max(0,Math.min(l,t-s)),start:s};s+=l}
    return null;
  }
  /* undo snapshots hold the clips and the page's graphics layers (where the name card sits, whether it shows) */
  const snap=()=>JSON.stringify({clips,sel:[...sel],L:o.layerState?o.layerState():null});
  function restore(s){const d=JSON.parse(s);clips=d.clips;sel=new Set(d.sel);if(d.L&&o.setLayerState)o.setLayerState(d.L)}
  function commit(before){undo.push(before);if(undo.length>100)undo.shift();redo.length=0;changed()}
  function changed(){time=Math.min(time,total()||o.emptyLength());render();o.onChange&&o.onChange();show(time)}

  function splitAt(t,quiet){
    const a=at(t);if(!a)return false;
    const c=clips[a.i];if(a.off<MIN||len(c)-a.off<MIN)return false;
    const before=snap(),c2={...c,id:++cid,in:c.in+a.off};c.out=c.in+a.off;
    clips.splice(a.i+1,0,c2);
    if(!quiet)commit(before);
    return true;
  }
  function removeSel(){
    if(!sel.size)return;const before=snap();
    const s=starts(),first=clips.findIndex(c=>sel.has(c.id));
    clips=clips.filter(c=>!sel.has(c.id));sel.clear();
    time=first>=0?Math.min(s[first],total()):time;
    commit(before);
  }
  function insert(nc,t){
    const before=snap();let idx=clips.length;
    if(clips.length&&t<total()-1e-6){
      const a=at(t),c=clips[a.i];
      if(a.off<MIN)idx=a.i;else if(len(c)-a.off<MIN)idx=a.i+1;else{splitAt(t,true);idx=a.i+1}
    }
    const t0=clips.slice(0,idx).reduce((s,c)=>s+len(c),0);
    clips.splice(idx,0,...nc);sel.clear();time=t0;
    commit(before);
  }
  function moveClip(id,to,before){
    const i=clips.findIndex(c=>c.id===id);if(i<0)return;
    const [c]=clips.splice(i,1);clips.splice(to>i?to-1:to,0,c);
    commit(before);
  }

  /* ---------- media ---------- */
  const okType=f=>f.type.startsWith("video/")||f.type.startsWith("image/")||/\.(mov|mp4|m4v|webm|jpe?g|png|heic|webp)$/i.test(f.name);
  function wait(el,ev,ms){return new Promise(r=>{let t;const f=()=>{clearTimeout(t);r(true)};el.addEventListener(ev,f,{once:true});t=setTimeout(()=>{el.removeEventListener(ev,f);r(false)},ms)})}
  async function loadMedia(f){
    const url=URL.createObjectURL(f),name=f.name||"klip";
    if(f.type.startsWith("image/")||/\.(jpe?g|png|heic|webp)$/i.test(f.name)){
      const img=new Image();img.src=url;
      if(!await wait(img,"load",15000)||!img.naturalWidth)throw new Error("foto");
      const m={id:++mid,kind:"image",url,name,img,w:img.naturalWidth,h:img.naturalHeight,dur:IMG_MAX};
      m.thumb=thumbOf(img,m.w,m.h);media.set(m.id,m);return m;
    }
    const v=mkVid();v.src=url;v.load();
    const p=v.play();if(p)p.then(()=>v.pause()).catch(()=>{});
    const okMeta=v.readyState>=1||await wait(v,"loadedmetadata",20000);
    if(!okMeta||!isFinite(v.duration)){v.remove();URL.revokeObjectURL(url);throw new Error("video")}
    const m={id:++mid,kind:"video",url,name,w:v.videoWidth,h:v.videoHeight,dur:v.duration};
    v.currentTime=Math.min(0.4,m.dur/2);await wait(v,"seeked",3000);
    if(v.readyState>=2)m.thumb=thumbOf(v,m.w,m.h);
    v.removeAttribute("src");v.load();v.remove();
    media.set(m.id,m);wave(m,f);
    return m;
  }
  function thumbOf(src,w,h){
    try{const c=document.createElement("canvas");c.width=80;c.height=48;const x=c.getContext("2d"),s=Math.max(80/w,48/h);
      x.drawImage(src,(80-w*s)/2,(48-h*s)/2,w*s,h*s);return c.toDataURL("image/jpeg",0.7)}catch(e){return null}
  }
  /* sound peaks for the A1 waveform, 100 per second (skipped for very large files to spare the phone's memory) */
  async function wave(m,f){
    if(f.size>160e6)return;
    try{
      const OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;if(!OAC)return;
      const ac=new OAC(1,2,44100),buf=await f.arrayBuffer();
      const ab=await new Promise((res,rej)=>{const p=ac.decodeAudioData(buf,res,rej);if(p&&p.then)p.then(res,rej)});
      const ch=ab.getChannelData(0),per=Math.max(1,Math.floor(ab.sampleRate/100)),n=Math.ceil(ch.length/per),pk=new Float32Array(n);
      for(let i=0;i<n;i++){let mx=0;const e=Math.min(ch.length,(i+1)*per);for(let j=i*per;j<e;j+=3){const a=ch[j]<0?-ch[j]:ch[j];if(a>mx)mx=a}pk[i]=mx}
      let top=0;for(let i=0;i<n;i++)if(pk[i]>top)top=pk[i];m.peaks=pk;m.peakTop=top||1;render();
    }catch(e){m.peaks=null}
  }
  async function addFiles(files,where){
    const list=[...files].filter(okType);if(!list.length)return;
    o.status&&o.status(list.length>1?`Duke hapur ${list.length} skedarë…`:"Duke hapur…");
    const nc=[],bad=[];
    for(const f of list){
      try{const m=await loadMedia(f);nc.push({id:++cid,m:m.id,in:0,out:m.kind==="image"?(clips.length||list.length>1?IMG_DUR:10):m.dur})}
      catch(e){bad.push(f.name)}
    }
    if(nc.length){const firstLoad=!clips.length;insert(nc,where==="end"?total():time);if(firstLoad){fit();o.onFirstMedia&&o.onFirstMedia(media.get(nc[0].m))}}
    o.status&&o.status(bad.length?`Nuk u hap: ${bad.join(", ")}`:"");
  }

  /* ---------- showing a frame ---------- */
  function park(v,c,off){
    return new Promise(res=>{
      const m=media.get(c.m),target=Math.max(0,Math.min(m.dur-0.04,c.in+off));let done=false;
      const fin=()=>{if(!done){done=true;res()}};
      const go=()=>{
        if(Math.abs(v.currentTime-target)<0.02&&v.readyState>=2)return fin();
        v.addEventListener("seeked",fin,{once:true});v.currentTime=target;setTimeout(fin,1500);
      };
      if(v._m!==m.id){
        v._m=m.id;v.src=m.url;v.load();
        const p=v.play();if(p)p.then(()=>{if(!playing||v!==cur?.v)v.pause()}).catch(()=>{});
        if(v.readyState>=1)go();else{v.addEventListener("loadedmetadata",go,{once:true});setTimeout(fin,10000)}
      }else go();
    });
  }
  let want=null,busySeek=false;
  function show(t){
    time=Math.max(0,Math.min(t,total()||o.emptyLength()));placeHead();
    if(playing)return;want=time;pump();
  }
  function pump(){
    if(busySeek||want==null)return;const t=want;want=null;
    const a=at(t);if(!a){cur=null;o.draw(time);return}
    const c=clips[a.i],m=media.get(c.m);
    if(m.kind==="image"){cur={c,m};o.draw(time);return pump()}
    busySeek=true;const v=els[0];
    park(v,c,a.off).then(()=>{busySeek=false;if(playing)return;/* playback took over the players meanwhile */v.pause();prev=cur?.v||prev;cur={c,m,v};o.draw(time);pump()});
  }
  /* the picture to draw now; during a switch the previous element still holds its last frame */
  function frame(){
    if(!cur)return null;
    if(cur.m.kind==="image")return {src:cur.m.img,w:cur.m.w,h:cur.m.h};
    const v=cur.v.readyState>=2?cur.v:(prev&&prev.readyState>=2?prev:null);
    return v?{src:v,w:v.videoWidth,h:v.videoHeight}:null;
  }

  /* ---------- playback ---------- */
  const raf=()=>new Promise(r=>requestAnimationFrame(r));
  async function play({from=time,to,onFrame}={}){
    to=to??(total()||o.emptyLength());stopFlag=false;want=null;
    while(busySeek)await raf();                           // let a scrub that is still seeking finish first
    playing=true;lockUI(true);
    try{
      if(!clips.length){                                    // no media: the graphics alone, on the clock
        const w0=performance.now()-from*1000;
        for(;;){await raf();const t=(performance.now()-w0)/1000;time=Math.min(t,to);placeHead();o.draw(time);onFrame&&onFrame(time);if(stopFlag||t>=to)break}
        return;
      }
      const st=starts();let a=at(from),i=a.i,v=els[0],nv=els[1];
      const startVideo=async(c)=>{try{await v.play()}catch(e){v.muted=true;try{await v.play()}catch(e2){}}};
      const parkNext=j=>{const c=clips[j];if(!c||media.get(c.m).kind!=="video")return Promise.resolve();return park(nv,c,0).then(()=>nv.pause())};
      let m=media.get(clips[i].m),w0=0;
      if(m.kind==="video"){await park(v,clips[i],a.off);cur={c:clips[i],m,v};await startVideo()}
      else{cur={c:clips[i],m};w0=performance.now()-a.off*1000}
      let pre=parkNext(i+1);
      for(;;){
        await raf();
        const c=clips[i],L=len(c);
        let local=m.kind==="video"?v.currentTime-c.in:(performance.now()-w0)/1000;
        const ended=local>=L-0.5/FPS||(m.kind==="video"&&v.ended);
        local=Math.min(local,L);
        const t=st[i]+local;time=Math.min(t,to);placeHead(true);o.draw(time);onFrame&&onFrame(time);
        if(stopFlag||t>=to-1e-3)break;
        if(!ended){if(m.kind==="video"&&v.paused&&!v.ended)v.play().catch(()=>{});continue}   // something paused it: carry on
        if(m.kind==="video")v.pause();
        i++;if(i>=clips.length)break;
        m=media.get(clips[i].m);
        if(m.kind==="video"){
          await pre;prev=v;[v,nv]=[nv,v];cur={c:clips[i],m,v};
          if(Math.abs(v.currentTime-clips[i].in)>0.05){await park(v,clips[i],0)}
          await startVideo();
        }else{cur={c:clips[i],m};w0=performance.now()}
        pre=parkNext(i+1);
      }
    }finally{
      els.forEach(e=>e.pause());playing=false;lockUI(false);placeHead();
    }
  }
  function stop(){stopFlag=true}
  /* iOS: a video may play with sound only if play() was first called inside a tap; touch both players now */
  function unlock(){els.forEach(v=>{v.muted=false;try{const p=v.play();if(p)p.then(()=>{if(!playing)v.pause()}).catch(()=>{})}catch(e){}})}
  let actx=null,dest=null;
  function audio(){
    if(actx)return {actx,dest};
    try{
      actx=new (window.AudioContext||window.webkitAudioContext)();dest=actx.createMediaStreamDestination();
      els.forEach(v=>{const s=actx.createMediaElementSource(v);s.connect(dest);s.connect(actx.destination)});
    }catch(e){dest=null}
    return {actx,dest};
  }

  /* ---------- UI ---------- */
  const R=o.mount;
  const svg=p=>`<svg viewBox="0 0 16 16" aria-hidden="true">${p}</svg>`,st_=`fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
  const ic={
    play:svg('<path d="M5 3v10l8-5z" fill="currentColor"/>'),
    pause:svg('<path d="M4.5 3h2.6v10H4.5zM8.9 3h2.6v10H8.9z" fill="currentColor"/>'),
    sel:svg('<path d="M3.5 2l9 6.6-4.1.5 2.3 4.6-1.7.8-2.3-4.6-3.2 2.9z" fill="currentColor"/>'),
    razor:svg(`<path d="M3 13L12.6 3.4a1.5 1.5 0 012.1 2.1L5.1 15H3z" ${st_}/>`),
    cut:svg(`<circle cx="4.2" cy="12" r="2.2" ${st_}/><circle cx="11.8" cy="12" r="2.2" ${st_}/><path d="M5.6 10.3L11.5 2M10.4 10.3L4.5 2" ${st_}/>`),
    del:svg(`<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.6 4.5l.6 9h5.6l.6-9" ${st_}/>`),
    add:svg(`<path d="M8 3v10M3 8h10" ${st_}/>`),
    undo:svg(`<path d="M5.5 3.5L2.5 6.5l3 3" ${st_}/><path d="M3 6.5h7a3.3 3.3 0 010 6.6H6.5" ${st_}/>`),
    redo:svg(`<path d="M10.5 3.5l3 3-3 3" ${st_}/><path d="M13 6.5H6a3.3 3.3 0 000 6.6h3.5" ${st_}/>`),
    zout:svg(`<circle cx="7" cy="7" r="4.6" ${st_}/><path d="M10.4 10.4L14 14M5 7h4" ${st_}/>`),
    zin:svg(`<circle cx="7" cy="7" r="4.6" ${st_}/><path d="M10.4 10.4L14 14M5 7h4M7 5v4" ${st_}/>`),
    eye:svg(`<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" ${st_}/><circle cx="8" cy="8" r="2" ${st_}/>`),
    eyeOff:svg(`<path d="M2.5 2.5l11 11M6.4 4A6.6 6.6 0 0114.5 8a10 10 0 01-1.9 2.4M10.1 12A6.7 6.7 0 011.5 8a10.5 10.5 0 012.6-3" ${st_}/>`),
  };
  R.innerHTML=`
  <div class="tl-bar">
    <button type="button" class="tl-play" data-a="play" title="Luaj / ndalo (Space)" aria-label="Luaj">${ic.play}</button>
    <span class="tl-tc"><b data-r="tc">00:00:00:00</b><span data-r="dur">00:00:00:00</span></span>
    <span class="tl-gap"></span>
    <span class="tl-seg" role="group" aria-label="Mjeti">
      <button type="button" class="tl-b" data-a="select" title="Përzgjidh (V)" aria-label="Përzgjidh">${ic.sel}</button>
      <button type="button" class="tl-b" data-a="razor" title="Brisk: prek klipin ku do ta presësh (C)" aria-label="Brisk">${ic.razor}</button>
    </span>
    <span class="tl-acts">
      <button type="button" class="tl-b tl-w" data-a="split" title="Prit te koka (⌘K)">${ic.cut}<span>Prit</span></button>
      <button type="button" class="tl-b tl-w" data-a="del" title="Fshi të zgjedhurën (Delete)">${ic.del}<span>Fshi</span></button>
      <button type="button" class="tl-b tl-w" data-a="add" title="Shto klip te koka">${ic.add}<span>Shto</span></button>
    </span>
    <span class="tl-seg">
      <button type="button" class="tl-b" data-a="undo" title="Zhbëj (⌘Z)" aria-label="Zhbëj">${ic.undo}</button>
      <button type="button" class="tl-b" data-a="redo" title="Ribëj (⇧⌘Z)" aria-label="Ribëj">${ic.redo}</button>
    </span>
    <span class="tl-seg">
      <button type="button" class="tl-b" data-a="zout" title="Zvogëlo (−)" aria-label="Zvogëlo">${ic.zout}</button>
      <button type="button" class="tl-b" data-a="zin" title="Zmadho (+)" aria-label="Zmadho">${ic.zin}</button>
    </span>
  </div>
  <div class="tl-body">
    <div class="tl-heads" data-r="heads"></div>
    <div class="tl-scroll" data-r="scroll">
      <div class="tl-inner" data-r="inner">
        <canvas class="tl-ruler" data-r="ruler"></canvas>
        <div data-r="lrows"></div>
        <div class="tl-row tl-r1" data-r="v1"></div>
        <div class="tl-row tl-ra" data-r="a1"></div>
        <div class="tl-ins" data-r="ins" hidden></div>
        <div class="tl-ph" data-r="ph"><i></i></div>
      </div>
    </div>
  </div>
  <div class="tl-empty" data-r="empty">Ngarko një video për ta prerë këtu. Prek një klip për ta zgjedhur, pastaj <b>Prit</b>, <b>Fshi</b> ose tërhiqe për ta renditur. <b>Shto</b> fut klipe te koka.</div>
  <input type="file" data-r="file" accept="video/*,image/*" multiple hidden>`;
  const q=r=>R.querySelector(`[data-r="${r}"]`);
  const sc=q("scroll"),inner=q("inner"),ruler=q("ruler"),heads=q("heads"),lrows=q("lrows"),rv1=q("v1"),ra1=q("a1"),ph=q("ph"),ins=q("ins"),fileIn=q("file");
  const btn=a=>R.querySelector(`[data-a="${a}"]`);
  const tc=s=>{const f=Math.floor(Math.max(0,s)*FPS+1e-6),fr=f%FPS,ss=Math.floor(f/FPS)%60,mm=Math.floor(f/FPS/60)%60,hh=Math.floor(f/FPS/3600);
    return [hh,mm,ss,fr].map(n=>String(n).padStart(2,"0")).join(":")};
  const xOf=t=>PAD+t*pps,tOf=x=>Math.max(0,(x-PAD)/pps);
  const layers=()=>o.layers?o.layers():[];
  const span=()=>Math.max(total(),o.emptyLength(),...layers().map(l=>l.on?l.end:0));
  const css=n=>getComputedStyle(R).getPropertyValue(n).trim();
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  let lsel=null;                                         // the selected graphics layer (its id), or null

  function render(){
    const T=span(),Wd=Math.max(sc.clientWidth,xOf(T)+120);
    inner.style.width=Wd+"px";
    q("empty").hidden=clips.length>0;
    const L=layers();
    /* track heads: graphics layers on top (V3, V2…), then the video and its sound */
    heads.innerHTML=`<div class="tl-hr"></div>`+L.map((l,i)=>`<div class="tl-hl"><span class="tl-tn">V${L.length-i+1}</span><b>${esc(l.label)}</b>${l.toggle?
      `<button type="button" class="tl-eye" data-eye="${l.id}" aria-pressed="${l.on}" title="${l.on?"Fshihe":"Shfaqe"}" aria-label="${l.on?"Fshihe":"Shfaqe"} ${esc(l.label)}">${l.on?ic.eye:ic.eyeOff}</button>`:""}</div>`).join("")+
      `<div class="tl-h1"><span class="tl-tn">V1</span><b>Video</b></div><div class="tl-ha"><span class="tl-tn">A1</span><b>Zëri</b></div>`;
    /* graphics layers: a bar from start to end, build-in and build-out shaded; a layer that is off shows a dashed outline to tap */
    lrows.innerHTML=L.map(l=>{
      const x=xOf(l.start),w=Math.max(8,(l.end-l.start)*pps),cls=`tl-l ${l.kind||""}${l.on?"":" off"}${lsel===l.id?" sel":""}`;
      const sh=l.on&&l.shade?`<i class="tl-sh" style="left:0;width:${Math.min(l.shade[0],l.end-l.start)*pps}px"></i><i class="tl-sh" style="right:0;width:${Math.min(l.shade[1],l.end-l.start)*pps}px"></i>`:"";
      return `<div class="tl-row tl-rl"><div class="${cls}" data-l="${l.id}" style="left:${x}px;width:${w}px">${sh}<span><b>${esc(l.on?l.label:"+ "+(l.offLabel||l.label))}</b>${l.on&&l.sub?` ${esc(l.sub)}`:""}</span>${l.on&&l.resize?'<i class="tl-tr r"></i>':""}</div></div>`;
    }).join("");
    /* V1 + A1 */
    rv1.innerHTML="";ra1.innerHTML="";
    const st=starts(),wave=css("--tl-wave")||"#3d8fae";
    clips.forEach((c,i)=>{
      const m=media.get(c.m),x=xOf(st[i]),w=Math.max(2,len(c)*pps),s=sel.has(c.id);
      const d=document.createElement("div");d.className="tl-c"+(m.kind==="image"?" img":"")+(s?" sel":"");d.dataset.id=c.id;
      d.style.left=x+"px";d.style.width=w+"px";if(m.thumb)d.style.backgroundImage=`url(${m.thumb})`;
      d.innerHTML=`<span>${esc(m.name)}</span><i class="tl-tr l"></i><i class="tl-tr r"></i>`;
      rv1.appendChild(d);
      const a=document.createElement("div");a.className="tl-a"+(s?" sel":"")+(m.kind==="image"?" none":"");a.dataset.id=c.id;a.style.left=x+"px";a.style.width=w+"px";
      if(m.kind==="video"){const cw=Math.min(Math.ceil(w),4000),cn=document.createElement("canvas");cn.width=cw;cn.height=30;a.appendChild(cn);drawWave(cn,m,c,wave)}
      ra1.appendChild(a);
    });
    drawRuler();placeHead();paintSel();
    btn("select").setAttribute("aria-pressed",tool==="select");btn("razor").setAttribute("aria-pressed",tool==="razor");
    sc.classList.toggle("razor",tool==="razor");
    btn("undo").disabled=!undo.length||locked;btn("redo").disabled=!redo.length||locked;
    btn("split").disabled=!clips.length||locked;
    q("dur").textContent=tc(total()||o.emptyLength());
  }
  /* selection changes only flip classes: rebuilding the clip under a finger would swallow the tap on phones */
  function paintSel(){
    R.querySelectorAll(".tl-c,.tl-a").forEach(e=>e.classList.toggle("sel",sel.has(+e.dataset.id)));
    R.querySelectorAll(".tl-l").forEach(e=>e.classList.toggle("sel",lsel===e.dataset.l));
    const l=layers().find(l=>l.id===lsel);
    btn("del").disabled=locked||!(sel.size||(l&&l.toggle&&l.on));
  }
  function selectClips(ids){sel=new Set(ids);if(sel.size)lsel=null;paintSel()}
  function selectLayer(id){lsel=id;if(id!=null)sel.clear();paintSel();o.onLayerSelect&&o.onLayerSelect(id)}
  function drawWave(cn,m,c,col){
    const x=cn.getContext("2d"),w=cn.width,h=cn.height;x.clearRect(0,0,w,h);
    x.fillStyle=col;
    if(!m.peaks){x.fillRect(0,h/2-0.5,w,1);return}
    const p=m.peaks,a0=c.in*100,a1=c.out*100,k=(a1-a0)/w;
    for(let i=0;i<w;i++){
      let mx=0;const s=Math.floor(a0+i*k),e=Math.max(s+1,Math.floor(a0+(i+1)*k));
      for(let j=s;j<e&&j<p.length;j++)if(p[j]>mx)mx=p[j];
      const v=Math.sqrt(mx/m.peakTop)*(h/2-2);x.fillRect(i,h/2-v,1,v*2||1);
    }
  }
  function drawRuler(){
    const w=sc.clientWidth,dpr=Math.min(2,window.devicePixelRatio||1),h=ruler.clientHeight||26;
    ruler.width=w*dpr;ruler.height=h*dpr;ruler.style.width=w+"px";ruler.style.transform=`translateX(${sc.scrollLeft}px)`;
    const x=ruler.getContext("2d");x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
    const steps=[1/FPS,5/FPS,0.5,1,2,5,10,15,30,60,120,300];
    const major=steps.find(s=>s*pps>=70)||600,minor=steps.filter(s=>s<major&&major/s>=4&&major/s<=10).pop()||major/5;
    const t0=tOf(sc.scrollLeft),t1=tOf(sc.scrollLeft+w);
    x.font="500 10px "+getComputedStyle(R).fontFamily;x.fillStyle=css("--muted")||"#6b6862";x.strokeStyle=css("--line")||"#dcd8d2";x.lineWidth=1;x.beginPath();
    for(let t=Math.floor(t0/minor)*minor;t<=t1+minor;t+=minor){
      const px=xOf(t)-sc.scrollLeft,isM=Math.abs(t/major-Math.round(t/major))<1e-6;
      x.moveTo(Math.round(px)+.5,h);x.lineTo(Math.round(px)+.5,isM?h-9:h-4);
      if(isM&&t>=0)x.fillText(major<1?tc(t).slice(3):tc(t).slice(3,8),px+4,12);
    }
    x.stroke();
  }
  function placeHead(follow){
    ph.style.transform=`translateX(${xOf(time)}px)`;q("tc").textContent=tc(time);
    if(follow){const x=xOf(time)-sc.scrollLeft;if(x>sc.clientWidth-40||x<0)sc.scrollLeft=xOf(time)-40}
  }
  function fit(){const T=Math.max(1,span());pps=Math.max(4,Math.min(400,(sc.clientWidth-PAD-30)/T));render()}
  function zoom(f,cx){
    const ax=cx??(xOf(time)-sc.scrollLeft),tAt=tOf(sc.scrollLeft+ax);
    pps=Math.max(4,Math.min(600,pps*f));render();sc.scrollLeft=Math.max(0,xOf(tAt)-ax);drawRuler();
  }
  function lockUI(on){locked=on;R.classList.toggle("busy",on);const p=btn("play");p.innerHTML=on?ic.pause:ic.play;p.setAttribute("aria-label",on?"Ndalo":"Luaj");render()}
  function deleteSel(){
    if(sel.size)return removeSel();
    const l=layers().find(l=>l.id===lsel);
    if(l&&l.toggle&&l.on){const before=snap();o.onLayerToggle(l.id,false);lsel=null;commit(before)}
  }

  /* toolbar */
  R.querySelector(".tl-bar").addEventListener("click",e=>{
    const b=e.target.closest("[data-a]");if(!b||b.disabled)return;const a=b.dataset.a;
    if(a==="play")return o.onPlayToggle();
    if(locked)return;
    if(a==="select"||a==="razor"){tool=a;render()}
    else if(a==="split"){const hit=splitAt(time);if(!hit)o.status&&o.status("Koka duhet të jetë brenda një klipi (jo në skaj).")}
    else if(a==="del")deleteSel();
    else if(a==="add")fileIn.click();
    else if(a==="undo"&&undo.length){redo.push(snap());restore(undo.pop());changed()}
    else if(a==="redo"&&redo.length){undo.push(snap());restore(redo.pop());changed()}
    else if(a==="zin")zoom(1.5);else if(a==="zout")zoom(1/1.5);
  });
  fileIn.onchange=()=>{addFiles(fileIn.files,"playhead");fileIn.value=""};
  /* the eye in a track head shows or hides that layer */
  heads.addEventListener("click",e=>{
    const b=e.target.closest("[data-eye]");if(!b||locked)return;
    const l=layers().find(l=>l.id===b.dataset.eye);if(!l)return;
    const before=snap();o.onLayerToggle(l.id,!l.on);lsel=l.on?(lsel===l.id?null:lsel):l.id;commit(before);
  });

  /* scrubbing on the ruler or the playhead */
  const scrubFrom=el=>el.addEventListener("pointerdown",e=>{
    if(locked)return;e.preventDefault();try{el.setPointerCapture(e.pointerId)}catch(_){}
    const go=ev=>{const r=sc.getBoundingClientRect();show(tOf(ev.clientX-r.left+sc.scrollLeft))};go(e);
    const mv=ev=>go(ev),up=()=>{el.removeEventListener("pointermove",mv);el.removeEventListener("pointerup",up);el.removeEventListener("pointercancel",up)};
    el.addEventListener("pointermove",mv);el.addEventListener("pointerup",up);el.addEventListener("pointercancel",up);
  });
  scrubFrom(ruler);scrubFrom(ph.querySelector("i"));

  /* tracks. Mouse: press selects at once and dragging moves/trims. Touch: a tap selects (a swipe scrolls the timeline),
     and a selected item can then be dragged or trimmed. Tapping empty track space moves the playhead. */
  inner.addEventListener("pointerdown",e=>{
    if(locked||e.target===ruler||e.target.closest(".tl-ph"))return;
    const r=sc.getBoundingClientRect(),pxOf=ev=>ev.clientX-r.left+sc.scrollLeft,px=pxOf(e),touch=e.pointerType!=="mouse";
    const lay=e.target.closest(".tl-l"),el=e.target.closest(".tl-c,.tl-a");
    const trim=e.target.classList.contains("tl-tr")?(e.target.classList.contains("l")?"l":"r"):null;
    const id=lay?lay.dataset.l:el?+el.dataset.id:null;
    const L=lay?layers().find(l=>l.id===id):null,i=el?clips.findIndex(c=>c.id===id):-1,c=clips[i];
    if((lay&&!L)||(el&&!c))return;
    if(el&&tool==="razor"){e.preventDefault();show(tOf(px));splitAt(tOf(px));return}
    const wasSel=lay?lsel===id:el?sel.has(id):false;
    if(el&&(e.shiftKey||e.metaKey||e.ctrlKey)){const s=new Set(sel);wasSel?s.delete(id):s.add(id);selectClips(s);return}

    /* a tap: select (or turn on an off layer), or move the playhead on empty track space */
    const tap=()=>{
      if(lay){if(!L.on){const before=snap();o.onLayerToggle(id,true);lsel=id;commit(before);o.onLayerSelect&&o.onLayerSelect(id)}
        else if(wasSel)show(tOf(px));else selectLayer(id)}
      else if(el){if(wasSel){if(sel.size>1)selectClips([id]);else show(tOf(px))}else selectClips([id])}
      else if(e.target.closest(".tl-row")){if(sel.size||lsel)selectLayer(null);show(tOf(px))}
    };
    const canDrag=(lay&&L.on&&(L.move||(trim&&L.resize)))||(el&&!!c);
    if(touch&&(!wasSel||!canDrag)){
      /* wait: if the finger travels it is a scroll (the browser takes it and cancels), otherwise it is a tap */
      const x0=e.clientX,y0=e.clientY;let gone=false;
      const mv=ev=>{if(Math.hypot(ev.clientX-x0,ev.clientY-y0)>8)gone=true};
      const end=ev=>{window.removeEventListener("pointermove",mv);window.removeEventListener("pointerup",end);window.removeEventListener("pointercancel",end);
        if(ev.type==="pointerup"&&!gone)tap()};
      window.addEventListener("pointermove",mv);window.addEventListener("pointerup",end);window.addEventListener("pointercancel",end);
      return;
    }
    if(!canDrag){tap();return}
    if(!wasSel){if(lay)selectLayer(id);else selectClips([id])}
    e.preventDefault();try{inner.setPointerCapture(e.pointerId)}catch(_){}
    const before=snap(),x0=e.clientX;let moved=false,dropAt=null;
    const m=c&&media.get(c.m),o0=c&&{in:c.in,out:c.out},st0=c?starts()[i]:0,l0=L&&{start:L.start,len:L.end-L.start};
    const mv=ev=>{
      const dx=ev.clientX-x0,dt=dx/pps;
      if(!moved&&Math.abs(dx)<5)return;moved=true;
      if(lay){
        /* graphics layer: drag moves it, the right edge sets how long it stays; snaps to the playhead and the clip cuts */
        const pts=[0,time,...starts(),total()],snapT=t=>{for(const p of pts)if(Math.abs(xOf(p)-xOf(t))<8)return p;return t};
        let s=l0.start,n=l0.len;
        if(trim==="r"){n=Math.max(L.minLen||1,snapT(l0.start+l0.len+dt)-l0.start)}
        else{s=snapT(l0.start+dt);const e2=snapT(s+n);if(e2!==s+n)s=e2-n}
        s=Math.max(L.minStart||0,s);
        o.onLayer(id,{start:s,len:n});render();                // the layers around it follow (the title ends where the name starts)
        show(trim==="r"?s+n-0.5:s+Math.min(1.2,n));
      }else if(trim==="l"){
        if(m.kind==="video")c.in=Math.max(0,Math.min(o0.out-MIN,o0.in+dt));else c.out=Math.max(MIN,Math.min(IMG_MAX,o0.out-dt));
        render();show(st0);
      }else if(trim==="r"){
        c.out=m.kind==="video"?Math.max(c.in+MIN,Math.min(m.dur,o0.out+dt)):Math.max(MIN,Math.min(IMG_MAX,o0.out+dt));
        render();show(st0+len(c)-1/FPS);
      }else{
        /* reorder: drop between clips, at the boundary nearest the pointer */
        const p=pxOf(ev),st=starts();let best=0,bd=1e9;
        for(let j=0;j<=clips.length;j++){const bx=xOf(j<clips.length?st[j]:total()),d=Math.abs(bx-p);if(d<bd){bd=d;best=j}}
        dropAt=best;ins.hidden=false;ins.style.transform=`translateX(${xOf(best<clips.length?st[best]:total())}px)`;
        const g=rv1.querySelector(`.tl-c[data-id="${id}"]`);if(g){g.style.transform=`translateX(${dx}px)`;g.classList.add("drag")}
      }
    };
    const up=ev=>{
      inner.removeEventListener("pointermove",mv);inner.removeEventListener("pointerup",up);inner.removeEventListener("pointercancel",up);ins.hidden=true;
      if(!moved){if(wasSel&&ev.type==="pointerup")tap();return}
      if(lay||trim)commit(before);
      else if(dropAt!=null&&dropAt!==i&&dropAt!==i+1)moveClip(id,dropAt,before);
      else render();
    };
    inner.addEventListener("pointermove",mv);inner.addEventListener("pointerup",up);inner.addEventListener("pointercancel",up);
  });

  sc.addEventListener("scroll",drawRuler,{passive:true});
  /* desktop: wheel scrolls sideways, ctrl/⌘ + wheel (or trackpad pinch) zooms */
  sc.addEventListener("wheel",e=>{
    if(e.ctrlKey||e.metaKey){e.preventDefault();zoom(Math.exp(-e.deltaY*0.01),e.clientX-sc.getBoundingClientRect().left)}
    else if(Math.abs(e.deltaY)>Math.abs(e.deltaX)){e.preventDefault();sc.scrollLeft+=e.deltaY}
  },{passive:false});
  /* phones: two fingers pinch the timeline */
  let pin=null;
  sc.addEventListener("touchstart",e=>{if(e.touches.length===2){const [a,b]=e.touches;pin={d:Math.abs(a.clientX-b.clientX)||1,p:pps,cx:(a.clientX+b.clientX)/2-sc.getBoundingClientRect().left}}},{passive:true});
  sc.addEventListener("touchmove",e=>{if(pin&&e.touches.length===2){e.preventDefault();const [a,b]=e.touches;const f=pin.p*(Math.abs(a.clientX-b.clientX)||1)/pin.d/pps;zoom(f,pin.cx)}},{passive:false});
  sc.addEventListener("touchend",e=>{if(e.touches.length<2)pin=null},{passive:true});
  window.addEventListener("resize",()=>render());
  /* the theme can change while the page is open; the ruler and waveforms are drawn with its colours */
  window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change",()=>render());

  /* Premiere shortcuts */
  document.addEventListener("keydown",e=>{
    const tag=(e.target.tagName||"").toLowerCase();if(tag==="input"||tag==="textarea"||tag==="select"||e.target.isContentEditable)return;
    const k=e.key.toLowerCase(),mod=e.metaKey||e.ctrlKey;
    if(k===" "){e.preventDefault();return o.onPlayToggle()}
    if(locked)return;
    if(mod&&k==="z"){e.preventDefault();btn(e.shiftKey?"redo":"undo").click();return}
    if(mod&&k==="k"){e.preventDefault();btn("split").click();return}
    if(mod)return;
    if(k==="v"){tool="select";render()}
    else if(k==="c"){tool="razor";render()}
    else if(k==="delete"||k==="backspace"){if(sel.size||lsel){e.preventDefault();deleteSel()}}
    else if(k==="arrowleft"||k==="arrowright"){e.preventDefault();show(time+(k==="arrowleft"?-1:1)*(e.shiftKey?1:1/FPS))}
    else if(k==="home"){show(0)}else if(k==="end"){show(total())}
    else if(k==="="||k==="+")zoom(1.5);else if(k==="-")zoom(1/1.5);
    else if(k==="escape"){selectLayer(null)}
  });

  return {
    get time(){return time},total,frame,show,play,stop,unlock,audio,addFiles,render,fit,
    hasClips:()=>clips.length>0,isPlaying:()=>playing,
    get selectedLayer(){return lsel},selectLayer:id=>{selectLayer(id)},
  };
}
