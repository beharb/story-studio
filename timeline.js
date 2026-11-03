/* Video Lajm editor: a small Premiere-style timeline.
   V2 shows the template's graphics, V1 holds the clips (cut from any number of uploaded videos or photos), A1 their sound.
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
  const snap=()=>JSON.stringify({clips,sel:[...sel]});
  function restore(s){const d=JSON.parse(s);clips=d.clips;sel=new Set(d.sel)}
  function commit(before){undo.push(before);if(undo.length>100)undo.shift();redo.length=0;changed()}
  function changed(){time=Math.min(time,total());render();o.onChange&&o.onChange();show(time)}

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
  const ic={
    play:'<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
    pause:'<svg viewBox="0 0 16 16"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>',
    sel:'<svg viewBox="0 0 16 16"><path d="M3 1.5l9.5 7.2-4.3.4 2.4 4.9-1.8.8-2.4-4.9L3 13z" fill="currentColor"/></svg>',
    razor:'<svg viewBox="0 0 16 16"><path d="M2 12.5L12.2 2.3a1.6 1.6 0 012.3 2.3L4.3 14.8H2z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9.5 5l1.5 1.5" stroke="currentColor" stroke-width="1.5"/></svg>',
    cut:'<svg viewBox="0 0 16 16"><circle cx="4" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 10.4L12 1.5M10.5 10.4L4 1.5" stroke="currentColor" stroke-width="1.5"/></svg>',
    del:'<svg viewBox="0 0 16 16"><path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.7 9.5h5.6l.7-9.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    add:'<svg viewBox="0 0 16 16"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.8"/></svg>',
    undo:'<svg viewBox="0 0 16 16"><path d="M5 3L2 6l3 3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 6H10a3.5 3.5 0 010 7H6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    redo:'<svg viewBox="0 0 16 16"><path d="M11 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.5 6H6a3.5 3.5 0 000 7h4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    zout:'<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.3 10.3L14 14M5 7h4" stroke="currentColor" stroke-width="1.5"/></svg>',
    zin:'<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.3 10.3L14 14M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.5"/></svg>',
  };
  R.innerHTML=`
  <div class="tl-bar">
    <button type="button" class="tl-b tl-play" data-a="play" title="Luaj / ndalo (Space)">${ic.play}</button>
    <span class="tl-tc"><b data-r="tc">00:00:00:00</b><span data-r="dur">00:00:00:00</span></span>
    <span class="tl-gap"></span>
    <span class="tl-grp">
      <button type="button" class="tl-b" data-a="select" title="Përzgjidh (V)">${ic.sel}</button>
      <button type="button" class="tl-b" data-a="razor" title="Brisk — prek klipin ku do ta presësh (C)">${ic.razor}</button>
    </span>
    <span class="tl-grp">
      <button type="button" class="tl-b tl-w" data-a="split" title="Prit te koka (⌘K)">${ic.cut}<span>Prit</span></button>
      <button type="button" class="tl-b tl-w" data-a="del" title="Fshi të zgjedhurën (Delete)">${ic.del}<span>Fshi</span></button>
      <button type="button" class="tl-b tl-w" data-a="add" title="Shto klip te koka">${ic.add}<span>Shto</span></button>
    </span>
    <span class="tl-grp">
      <button type="button" class="tl-b" data-a="undo" title="Zhbëj (⌘Z)">${ic.undo}</button>
      <button type="button" class="tl-b" data-a="redo" title="Ribëj (⇧⌘Z)">${ic.redo}</button>
    </span>
    <span class="tl-grp">
      <button type="button" class="tl-b" data-a="zout" title="Zvogëlo (−)">${ic.zout}</button>
      <button type="button" class="tl-b" data-a="zin" title="Zmadho (+)">${ic.zin}</button>
    </span>
  </div>
  <div class="tl-body">
    <div class="tl-heads"><div class="tl-hr"></div><div class="tl-h2"><b>V2</b><span>Grafika</span></div><div class="tl-h1"><b>V1</b><span>Video</span></div><div class="tl-ha"><b>A1</b><span>Zëri</span></div></div>
    <div class="tl-scroll" data-r="scroll">
      <div class="tl-inner" data-r="inner">
        <canvas class="tl-ruler" data-r="ruler"></canvas>
        <div class="tl-row tl-r2" data-r="v2"></div>
        <div class="tl-row tl-r1" data-r="v1"></div>
        <div class="tl-row tl-ra" data-r="a1"></div>
        <div class="tl-ins" data-r="ins" hidden></div>
        <div class="tl-ph" data-r="ph"><i></i></div>
      </div>
    </div>
  </div>
  <div class="tl-empty" data-r="empty">Ngarko një video për ta prerë këtu. Prit me <b>✂ Prit</b> te koka ose me brisk, fshi pjesën e zgjedhur, shto klipe në mes, tërhiqi për t'i renditur.</div>
  <input type="file" data-r="file" accept="video/*,image/*" multiple hidden>`;
  const q=r=>R.querySelector(`[data-r="${r}"]`);
  const sc=q("scroll"),inner=q("inner"),ruler=q("ruler"),rv2=q("v2"),rv1=q("v1"),ra1=q("a1"),ph=q("ph"),ins=q("ins"),fileIn=q("file");
  const tc=s=>{const f=Math.floor(Math.max(0,s)*FPS+1e-6),fr=f%FPS,ss=Math.floor(f/FPS)%60,mm=Math.floor(f/FPS/60)%60,hh=Math.floor(f/FPS/3600);
    return [hh,mm,ss,fr].map(n=>String(n).padStart(2,"0")).join(":")};
  const xOf=t=>PAD+t*pps,tOf=x=>Math.max(0,(x-PAD)/pps);
  const span=()=>Math.max(total(),o.graphicsEnd?o.graphicsEnd():0,o.emptyLength());

  function render(){
    const T=span(),Wd=Math.max(sc.clientWidth,xOf(T)+120);
    inner.style.width=Wd+"px";
    q("empty").hidden=clips.length>0;
    /* V2: the template's graphics, with its build-in and build-out shaded */
    const gE=o.graphicsEnd?o.graphicsEnd():0;
    rv2.innerHTML=gE>0?`<div class="tl-g" style="left:${xOf(0)}px;width:${gE*pps}px"><span>LAJMET VIDEO · grafika</span>
      <i style="left:0;width:${Math.min(2.5,gE)*pps}px"></i><i style="left:${Math.max(0,gE-2.1)*pps}px;width:${Math.min(2.1,gE)*pps}px"></i></div>`:"";
    /* V1 + A1 */
    rv1.innerHTML="";ra1.innerHTML="";
    const st=starts();
    clips.forEach((c,i)=>{
      const m=media.get(c.m),x=xOf(st[i]),w=Math.max(2,len(c)*pps),s=sel.has(c.id);
      const d=document.createElement("div");d.className="tl-c"+(m.kind==="image"?" img":"")+(s?" sel":"");d.dataset.id=c.id;
      d.style.left=x+"px";d.style.width=w+"px";
      d.innerHTML=`<div class="tl-cn">${m.thumb?`<img src="${m.thumb}" alt="">`:""}<span>${esc(m.name)}</span></div><i class="tl-tr l"></i><i class="tl-tr r"></i>`;
      rv1.appendChild(d);
      const a=document.createElement("div");a.className="tl-a"+(s?" sel":"")+(m.kind==="image"?" none":"");a.dataset.id=c.id;a.style.left=x+"px";a.style.width=w+"px";
      if(m.kind==="video"){const cw=Math.min(Math.ceil(w),4000),cn=document.createElement("canvas");cn.width=cw;cn.height=36;a.appendChild(cn);drawWave(cn,m,c)}
      ra1.appendChild(a);
    });
    drawRuler();placeHead();
    R.querySelector('[data-a="select"]').classList.toggle("on",tool==="select");
    R.querySelector('[data-a="razor"]').classList.toggle("on",tool==="razor");
    sc.classList.toggle("razor",tool==="razor");
    R.querySelector('[data-a="undo"]').disabled=!undo.length||locked;
    R.querySelector('[data-a="redo"]').disabled=!redo.length||locked;
    R.querySelector('[data-a="del"]').disabled=!sel.size||locked;
    R.querySelector('[data-a="split"]').disabled=!clips.length||locked;
    q("dur").textContent=tc(total()||o.emptyLength());
  }
  const esc=s=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  function drawWave(cn,m,c){
    const x=cn.getContext("2d"),w=cn.width,h=cn.height;x.clearRect(0,0,w,h);
    x.fillStyle="rgba(170,220,245,.9)";
    if(!m.peaks){x.fillRect(0,h/2-0.5,w,1);return}
    const p=m.peaks,a0=c.in*100,a1=c.out*100,k=(a1-a0)/w;
    for(let i=0;i<w;i++){
      let mx=0;const s=Math.floor(a0+i*k),e=Math.max(s+1,Math.floor(a0+(i+1)*k));
      for(let j=s;j<e&&j<p.length;j++)if(p[j]>mx)mx=p[j];
      const v=Math.sqrt(mx/m.peakTop)*(h/2-2);x.fillRect(i,h/2-v,1,v*2||1);
    }
  }
  function drawRuler(){
    const w=sc.clientWidth,dpr=Math.min(2,window.devicePixelRatio||1),h=ruler.clientHeight||24;
    ruler.width=w*dpr;ruler.height=h*dpr;ruler.style.width=w+"px";ruler.style.transform=`translateX(${sc.scrollLeft}px)`;
    const x=ruler.getContext("2d");x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
    const steps=[1/FPS,5/FPS,0.5,1,2,5,10,15,30,60,120,300];
    const major=steps.find(s=>s*pps>=70)||600,minor=steps.filter(s=>s<major&&major/s>=4&&major/s<=10).pop()||major/5;
    const t0=tOf(sc.scrollLeft),t1=tOf(sc.scrollLeft+w);
    x.font="10px "+getComputedStyle(R).fontFamily;x.fillStyle="#8d8d8d";x.strokeStyle="#5a5a5a";x.lineWidth=1;x.beginPath();
    for(let t=Math.floor(t0/minor)*minor;t<=t1+minor;t+=minor){
      const px=xOf(t)-sc.scrollLeft,isM=Math.abs(t/major-Math.round(t/major))<1e-6;
      x.moveTo(Math.round(px)+.5,h);x.lineTo(Math.round(px)+.5,isM?h-10:h-5);
      if(isM&&t>=0)x.fillText(major<1?tc(t).slice(3):tc(t).slice(3,8),px+3,11);
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
  function lockUI(on){locked=on;R.classList.toggle("busy",on);R.querySelector('[data-a="play"]').innerHTML=on?ic.pause:ic.play;render()}

  /* toolbar */
  R.querySelector(".tl-bar").addEventListener("click",e=>{
    const b=e.target.closest("[data-a]");if(!b||b.disabled)return;const a=b.dataset.a;
    if(a==="play")return o.onPlayToggle();
    if(locked)return;
    if(a==="select"||a==="razor"){tool=a;render()}
    else if(a==="split"){const hit=splitAt(time);if(!hit)o.status&&o.status("Koka duhet të jetë brenda një klipi (jo në skaj).")}
    else if(a==="del")removeSel();
    else if(a==="add")fileIn.click();
    else if(a==="undo"&&undo.length){redo.push(snap());restore(undo.pop());changed()}
    else if(a==="redo"&&redo.length){undo.push(snap());restore(redo.pop());changed()}
    else if(a==="zin")zoom(1.5);else if(a==="zout")zoom(1/1.5);
  });
  fileIn.onchange=()=>{addFiles(fileIn.files,"playhead");fileIn.value=""};

  /* scrubbing on the ruler or the playhead */
  const scrubFrom=el=>el.addEventListener("pointerdown",e=>{
    if(locked)return;e.preventDefault();try{el.setPointerCapture(e.pointerId)}catch(_){}
    const go=ev=>{const r=sc.getBoundingClientRect();show(tOf(ev.clientX-r.left+sc.scrollLeft))};go(e);
    const mv=ev=>go(ev),up=()=>{el.removeEventListener("pointermove",mv);el.removeEventListener("pointerup",up);el.removeEventListener("pointercancel",up)};
    el.addEventListener("pointermove",mv);el.addEventListener("pointerup",up);el.addEventListener("pointercancel",up);
  });
  scrubFrom(ruler);scrubFrom(ph);

  /* clips: select, razor, trim edges, drag to reorder; empty track area moves the playhead */
  inner.addEventListener("pointerdown",e=>{
    if(locked||e.target===ruler||e.target.closest(".tl-ph"))return;
    const r=sc.getBoundingClientRect(),px=e.clientX-r.left+sc.scrollLeft,el=e.target.closest(".tl-c,.tl-a");
    if(!el){if(e.target.closest(".tl-row")){sel.clear();render();show(tOf(px))}return}
    const id=+el.dataset.id,i=clips.findIndex(c=>c.id===id),c=clips[i];if(!c)return;
    if(tool==="razor"){e.preventDefault();show(tOf(px));splitAt(tOf(px));return}
    const trim=e.target.classList.contains("tl-tr")?(e.target.classList.contains("l")?"l":"r"):null;
    const multi=e.shiftKey||e.metaKey||e.ctrlKey,wasSel=sel.has(id);
    if(multi){wasSel?sel.delete(id):sel.add(id);render();return}
    if(!wasSel){sel=new Set([id]);render()}
    /* touch: an unselected clip scrolls the timeline; once selected it can be trimmed or dragged */
    if(e.pointerType==="touch"&&!wasSel&&!trim)return;
    e.preventDefault();try{inner.setPointerCapture(e.pointerId)}catch(_){}
    const before=snap(),x0=e.clientX,m=media.get(c.m),o0={in:c.in,out:c.out},st0=starts()[i];let moved=false,dropAt=null;
    const mv=ev=>{
      const dx=ev.clientX-x0,dt=dx/pps;
      if(!moved&&Math.abs(dx)<5)return;moved=true;
      if(trim==="l"){
        if(m.kind==="video")c.in=Math.max(0,Math.min(o0.out-MIN,o0.in+dt));else c.out=Math.max(MIN,Math.min(IMG_MAX,o0.out-dt));
        render();show(st0);
      }else if(trim==="r"){
        c.out=m.kind==="video"?Math.max(c.in+MIN,Math.min(m.dur,o0.out+dt)):Math.max(MIN,Math.min(IMG_MAX,o0.out+dt));
        render();show(st0+len(c)-1/FPS);
      }else{
        /* reorder: drop between clips, at the boundary nearest the pointer */
        const p=ev.clientX-r.left+sc.scrollLeft,st=starts();let best=0,bd=1e9;
        for(let j=0;j<=clips.length;j++){const bx=xOf(j<clips.length?st[j]:total()),d=Math.abs(bx-p);if(d<bd){bd=d;best=j}}
        dropAt=best;ins.hidden=false;ins.style.transform=`translateX(${xOf(best<clips.length?st[best]:total())}px)`;
        const g=rv1.querySelector(`.tl-c[data-id="${id}"]`);if(g){g.style.transform=`translateX(${dx}px)`;g.classList.add("drag")}
      }
    };
    const up=()=>{
      inner.removeEventListener("pointermove",mv);inner.removeEventListener("pointerup",up);inner.removeEventListener("pointercancel",up);ins.hidden=true;
      if(!moved){if(wasSel&&!trim){if(sel.size>1){sel=new Set([id]);render()}else show(tOf(x0-r.left+sc.scrollLeft))/* second tap parks the playhead there */}return}
      if(trim)commit(before);
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

  /* Premiere shortcuts */
  document.addEventListener("keydown",e=>{
    const tag=(e.target.tagName||"").toLowerCase();if(tag==="input"||tag==="textarea"||tag==="select"||e.target.isContentEditable)return;
    const k=e.key.toLowerCase(),mod=e.metaKey||e.ctrlKey;
    if(k===" "){e.preventDefault();return o.onPlayToggle()}
    if(locked)return;
    if(mod&&k==="z"){e.preventDefault();R.querySelector(`[data-a="${e.shiftKey?"redo":"undo"}"]`).click();return}
    if(mod&&k==="k"){e.preventDefault();R.querySelector('[data-a="split"]').click();return}
    if(mod)return;
    if(k==="v"){tool="select";render()}
    else if(k==="c"){tool="razor";render()}
    else if(k==="delete"||k==="backspace"){if(sel.size){e.preventDefault();removeSel()}}
    else if(k==="arrowleft"||k==="arrowright"){e.preventDefault();show(time+(k==="arrowleft"?-1:1)*(e.shiftKey?1:1/FPS))}
    else if(k==="home"){show(0)}else if(k==="end"){show(total())}
    else if(k==="="||k==="+")zoom(1.5);else if(k==="-")zoom(1/1.5);
    else if(k==="escape"){sel.clear();render()}
  });

  return {
    get time(){return time},total,frame,show,play,stop,unlock,audio,addFiles,render,fit,
    hasClips:()=>clips.length>0,isPlaying:()=>playing,
  };
}
