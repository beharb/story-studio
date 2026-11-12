/* Auto re-frame for Video Lajm (like Premiere's): finds the person in each video, follows them and keeps them in the
   middle of the 9:16 frame however they move.
   Analysis: every stretch of each video that is used on the timeline is sampled 5 times a second on a hidden player;
   MediaPipe's object detector finds the people and a face detector, run on the chosen person's head area, pins the face.
   One person is followed: the biggest, most central one at the start, then whoever is nearest to where they were.
   A scene cut inside the source starts the choice over. The path is held still inside a small dead zone and then
   smoothed both ways, so the "camera" glides instead of twitching. Needs internet the first time (the models). */
const RF_STEP=0.2;                                   // seconds between samples
const RF_CDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const RF_MODELS={
  obj:"https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
  face:"https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"};
/* how the camera moves: smoothing (s, gaussian sigma), dead zone and leash (shares of the visible width): however smooth,
   the camera never lets the face get further than the leash from the middle */
const RF_MOTION={slow:{sigma:0.9,dz:0.08,leash:0.2},normal:{sigma:0.4,dz:0.05,leash:0.12},fast:{sigma:0.2,dz:0.02,leash:0.06}};
const RF_CUT=0.16;                                   // mean grey difference of two samples that counts as a scene cut

function createReframer(){
  let det=null,loading=null,motion="normal",running=null,again=false;
  const tracks=new Map();                            // media id -> {kind,dur,aspect,raw:Map(i->sample),X,Y}
  const work=document.createElement("canvas"),wctx=work.getContext("2d",{willReadFrequently:true});
  const fc=document.createElement("canvas"),fctx=fc.getContext("2d");fc.width=fc.height=192;
  const tiny=document.createElement("canvas"),tctx=tiny.getContext("2d",{willReadFrequently:true});tiny.width=32;tiny.height=18;

  async function models(){
    if(det)return det;
    if(!loading)loading=(async()=>{
      const V=await import(RF_CDN+"/vision_bundle.mjs");
      const fs=await V.FilesetResolver.forVisionTasks(RF_CDN+"/wasm");
      const mk=async(C,path,opt)=>{
        try{return await C.createFromOptions(fs,{baseOptions:{modelAssetPath:path,delegate:"GPU"},runningMode:"IMAGE",...opt})}
        catch(e){return await C.createFromOptions(fs,{baseOptions:{modelAssetPath:path,delegate:"CPU"},runningMode:"IMAGE",...opt})}
      };
      const obj=await mk(V.ObjectDetector,RF_MODELS.obj,{scoreThreshold:0.3,maxResults:8,categoryAllowlist:["person"]});
      let face=null;try{face=await mk(V.FaceDetector,RF_MODELS.face,{minDetectionConfidence:0.5})}catch(e){}
      det={obj,face};return det;
    })().catch(e=>{loading=null;throw e});
    return loading;
  }

  /* ---------- one picture ---------- */
  function faceIn(src,sw,sh,rx,ry,rs){                 // largest face inside a square region of the source (source pixels)
    if(!det.face)return null;
    fctx.fillStyle="#000";fctx.fillRect(0,0,192,192);
    try{fctx.drawImage(src,rx,ry,rs,rs,0,0,192,192)}catch(e){return null}
    const r=det.face.detect(fc).detections||[];let best=null;
    for(const d of r){const b=d.boundingBox;if(!best||b.width*b.height>best.width*best.height)best=b}
    if(!best)return null;
    return {x:(rx+(best.originX+best.width/2)/192*rs)/sw,y:(ry+(best.originY+best.height/2)/192*rs)/sh,h:best.height/192*rs/sh};
  }
  function look(src,sw,sh){
    const s=Math.min(1,640/Math.max(sw,sh)),cw=Math.max(2,Math.round(sw*s)),ch=Math.max(2,Math.round(sh*s));
    if(work.width!==cw||work.height!==ch){work.width=cw;work.height=ch}
    wctx.drawImage(src,0,0,cw,ch);
    tctx.drawImage(work,0,0,32,18);
    const px=tctx.getImageData(0,0,32,18).data,gray=new Uint8Array(576);
    for(let i=0;i<576;i++)gray[i]=(px[i*4]*3+px[i*4+1]*6+px[i*4+2])/10;
    const people=(det.obj.detect(work).detections||[]).map(d=>{const b=d.boundingBox;
      return {cx:(b.originX+b.width/2)/cw,cy:(b.originY+b.height/2)/ch,x:b.originX/cw,y:b.originY/ch,w:b.width/cw,h:b.height/ch,sc:d.categories?.[0]?.score??0.5}});
    return {people,gray};
  }
  function pick(people,prev){
    if(!people.length)return null;
    if(prev){
      let best=null,bd=1e9;
      for(const p of people){const d=Math.hypot(p.cx-prev.cx,(p.cy-prev.cy)*0.6)+0.35*Math.abs(Math.log(p.h/prev.h));if(d<bd){bd=d;best=p}}
      if(bd<0.3)return best;
    }
    let best=null,bs=-1;
    for(const p of people){const s=Math.sqrt(p.w*p.h)*(1-0.9*Math.abs(p.cx-0.5))*(0.5+p.sc);if(s>bs){bs=s;best=p}}
    return best;
  }
  /* the point to keep in the middle: the face, or else where the head of the person box should be */
  function aim(src,sw,sh,p){
    if(!p){const f=faceIn(src,sw,sh,0,0,Math.max(sw,sh));return f?{x:f.x,y:f.y,box:{cx:f.x,cy:f.y+f.h*2,h:f.h*5}}:null}
    const side=Math.max(p.w*sw,p.h*sh*0.42),rx=p.cx*sw-side/2,ry=p.y*sh-side*0.12;
    const f=faceIn(src,sw,sh,rx,ry,side);
    if(f&&f.x>p.x-0.02&&f.x<p.x+p.w+0.02)return {x:f.x,y:f.y,box:p};
    return {x:p.cx,y:p.y+Math.min(p.h,p.w*1.6)*0.13,box:p};
  }
  const diff=(a,b)=>{let s=0;for(let i=0;i<576;i++)s+=Math.abs(a[i]-b[i]);return s/576/255};

  /* ---------- analysing the used stretches ---------- */
  function seek(v,t){
    return new Promise(res=>{
      if(Math.abs(v.currentTime-t)<1e-3&&v.readyState>=2)return res(true);
      const done=ok=>{clearTimeout(to);v.removeEventListener("seeked",on);res(ok)},on=()=>done(true),to=setTimeout(()=>done(false),5000);
      v.addEventListener("seeked",on);v.currentTime=t;
    });
  }
  async function openVideo(url){
    const v=document.createElement("video");v.muted=true;v.playsInline=true;v.setAttribute("playsinline","");v.preload="auto";
    v.className="tl-dec";document.body.appendChild(v);v.src=url;v.load();
    const p=v.play();if(p)p.then(()=>v.pause()).catch(()=>{});
    if(v.readyState<1)await new Promise(r=>{v.addEventListener("loadedmetadata",r,{once:true});setTimeout(r,15000)});
    v.pause();return v;
  }
  function trackOf(m){
    let tr=tracks.get(m.id);
    if(!tr){tr={kind:m.kind,dur:m.kind==="image"?0:m.dur,aspect:m.w/m.h,raw:new Map(),X:null,Y:null};tracks.set(m.id,tr)}
    return tr;
  }
  /* which sample indices of each media the timeline uses (a little either side, for smoothing at the edges) */
  function wanted(used){
    const out=new Map();
    for(const u of used){
      const m=u.m;if(!m)continue;
      if(!out.has(m.id))out.set(m.id,{m,idx:new Set()});const s=out.get(m.id).idx;
      if(m.kind==="image"){s.add(0);continue}
      const a=Math.max(0,Math.floor((u.in-1)/RF_STEP)),b=Math.min(Math.floor((m.dur-0.05)/RF_STEP),Math.ceil((u.out+1)/RF_STEP));
      for(let i=a;i<=b;i++)s.add(i);
    }
    return out;
  }
  function todo(used){let n=0;for(const {m,idx} of wanted(used).values()){const tr=tracks.get(m.id);for(const i of idx)if(!tr||!tr.raw.has(i))n++}return n}

  async function work1(used,onProgress,onUpdate){
    const W=wanted(used),total=todo(used);let done=0;
    if(!total){W.forEach(({m})=>build(trackOf(m)));onUpdate&&onUpdate();return}
    await models();
    for(const {m,idx} of W.values()){
      const tr=trackOf(m),list=[...idx].filter(i=>!tr.raw.has(i)).sort((a,b)=>a-b);
      if(!list.length){build(tr);continue}
      if(m.kind==="image"){
        const r=look(m.img,m.w,m.h),a=aim(m.img,m.w,m.h,pick(r.people,null));
        tr.raw.set(0,a?{x:a.x,y:a.y,box:a.box,gray:r.gray}:{x:null,y:null,box:null,gray:r.gray});
        done++;onProgress&&onProgress(done/total);build(tr);onUpdate&&onUpdate();continue;
      }
      const v=await openVideo(m.url);let since=0;
      try{
        for(const i of list){
          if(again)return;                               // the timeline changed: start over with the new list
          await seek(v,Math.min(m.dur-0.04,i*RF_STEP));
          const sw=v.videoWidth,sh=v.videoHeight;
          if(!sw||v.readyState<2){tr.raw.set(i,{x:null,y:null,box:null,gray:null});done++;continue}
          const r=look(v,sw,sh),b4=tr.raw.get(i-1);
          const cut=!!(b4&&b4.gray&&diff(b4.gray,r.gray)>RF_CUT);
          let prev=!cut&&b4?b4.box:null;
          if(!prev&&!cut){for(let k=2;k<=8;k++){const q=tr.raw.get(i-k);if(!q)break;if(q.cut)break;if(q.box){prev=q.box;break}}}
          const a=aim(v,sw,sh,pick(r.people,prev));
          tr.raw.set(i,a?{x:a.x,y:a.y,box:a.box,gray:r.gray,cut}:{x:null,y:null,box:null,gray:r.gray,cut});
          done++;onProgress&&onProgress(done/total);
          if(++since>=25){since=0;build(tr);onUpdate&&onUpdate()}
        }
      }finally{v.pause();v.removeAttribute("src");v.load();v.remove()}
      build(tr);onUpdate&&onUpdate();
    }
  }

  /* ---------- the camera path ---------- */
  function build(tr){
    const M=RF_MOTION[motion]||RF_MOTION.normal;
    if(tr.kind==="image"){const r=tr.raw.get(0);tr.X=new Float32Array([r&&r.x!=null?r.x:NaN]);tr.Y=new Float32Array([r&&r.y!=null?r.y:NaN]);return}
    const n=Math.floor(tr.dur/RF_STEP)+2,X=new Float32Array(n).fill(NaN),Y=new Float32Array(n).fill(NaN);
    /* visible share of the source at 100%: a 16:9 video shows about a third of its width in 9:16 */
    const vis=Math.min(1,(9/16)/tr.aspect),visY=Math.min(1,tr.aspect/(9/16));
    const segs=[];let cur=null;
    for(let i=0;i<n;i++){
      const r=tr.raw.get(i);
      if(!r||r.cut){if(cur)segs.push(cur);cur=r?[i]:null;continue}
      if(!cur)cur=[i];else cur.push(i);
    }
    if(cur)segs.push(cur);
    const kern=sig=>{const K=Math.ceil(sig*3),g=[];for(let k=-K;k<=K;k++)g.push(Math.exp(-k*k/(2*sig*sig)));return [g,K]};
    const [g,K]=kern(M.sigma/RF_STEP),[g2,K2]=kern(0.12/RF_STEP);
    for(const s of segs){
      const xs=s.map(i=>tr.raw.get(i).x),ys=s.map(i=>tr.raw.get(i).y);
      if(!fill(xs)||!fill(ys))continue;
      const rx=xs.slice(),ry=ys.slice();
      hold(xs,M.dz*vis);hold(ys,M.dz*visY*1.5);
      const sx=blur(leash(blur(xs,g,K),rx,M.leash*vis),g2,K2),sy=blur(leash(blur(ys,g,K),ry,M.leash*visY*1.5),g2,K2);
      s.forEach((i,j)=>{X[i]=sx[j];Y[i]=sy[j]});
    }
    tr.X=X;tr.Y=Y;
  }
  function fill(a){                                   // gaps: straight line between the known points, held at the ends
    const k=[];a.forEach((v,i)=>{if(v!=null)k.push(i)});if(!k.length)return false;
    for(let i=0;i<k[0];i++)a[i]=a[k[0]];for(let i=k[k.length-1]+1;i<a.length;i++)a[i]=a[k[k.length-1]];
    for(let j=0;j<k.length-1;j++){const p=k[j],q=k[j+1];for(let i=p+1;i<q;i++)a[i]=a[p]+(a[q]-a[p])*(i-p)/(q-p)}
    return true;
  }
  function hold(a,dz){                                // dead zone: the camera only moves once the subject is dz away
    if(!a.length)return;let c=a[0];
    /* start where the subject settles, not where it happens to be on the very first sample */
    const m=a.slice(0,Math.min(a.length,8)).sort((p,q)=>p-q);c=m[m.length>>1];
    for(let i=0;i<a.length;i++){const d=a[i]-c;if(d>dz)c=a[i]-dz;else if(d<-dz)c=a[i]+dz;a[i]=c}
  }
  function leash(c,raw,L){return c.map((v,i)=>Math.max(raw[i]-L,Math.min(raw[i]+L,v)))}
  function blur(a,g,K){
    const out=new Array(a.length);
    for(let i=0;i<a.length;i++){let s=0,w=0;for(let k=-K;k<=K;k++){const j=i+k;if(j<0||j>=a.length)continue;s+=a[j]*g[k+K];w+=g[k+K]}out[i]=s/w}
    return out;
  }

  /* where the subject is (0..1 of the source) at source time t, or null where nothing was found */
  function at(mid,t){
    const tr=tracks.get(mid);if(!tr||!tr.X)return null;
    if(tr.kind==="image")return isNaN(tr.X[0])?null:{x:tr.X[0],y:tr.Y[0]};
    const f=Math.max(0,t)/RF_STEP,i=Math.floor(f),u=f-i,X=tr.X,Y=tr.Y;
    const ok=j=>j>=0&&j<X.length&&!isNaN(X[j]);
    const nx=tr.raw.get(i+1);
    if(ok(i)&&ok(i+1)&&!(nx&&nx.cut))return {x:X[i]+(X[i+1]-X[i])*u,y:Y[i]+(Y[i+1]-Y[i])*u};
    for(const j of u<0.5?[i,i+1,i-1,i+2]:[i+1,i,i+2,i-1])if(ok(j))return {x:X[j],y:Y[j]};
    return null;
  }

  /* analyse what the timeline uses; calls made while one runs are folded into a single re-run */
  function analyze(used,onProgress,onUpdate){
    if(running){again=true;running.next={used,onProgress,onUpdate};return running.p}
    const job={};running=job;
    job.p=(async()=>{
      let args={used,onProgress,onUpdate};
      try{
        for(;;){
          again=false;await work1(args.used,args.onProgress,args.onUpdate);
          if(!again)break;args=job.next;
        }
      }finally{running=null}
    })();
    return job.p;
  }
  function setMotion(v){motion=v;tracks.forEach(build)}
  return {analyze,at,setMotion,busy:()=>!!running,idle:()=>running?running.p.catch(()=>{}):Promise.resolve(),
    pending:used=>todo(used),found:mid=>{const tr=tracks.get(mid);return !!(tr&&tr.X&&[...tr.X].some(v=>!isNaN(v)))}};
}
