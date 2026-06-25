/* app.js — Voice Kaleidoscope — LUT方式 */
'use strict';

// ── DOM ──────────────────────────────────────────────────
const video       = document.getElementById('video');
const canvas      = document.getElementById('canvas');
const ctx         = canvas.getContext('2d');
const startScreen = document.getElementById('start-screen');
const startBtn    = document.getElementById('start-btn');
const startError  = document.getElementById('start-error');
const mainView    = document.getElementById('main-view');
const canvasWrap  = document.getElementById('canvas-wrap');
const beatRing    = document.getElementById('beat-ring');
const volFill     = document.getElementById('vol-fill');
const volNum      = document.getElementById('vol-num');
const modeInfo    = document.getElementById('mode-info');

// ── State ────────────────────────────────────────────────
let SIZE = 360;
let running = false;
const COLS_LIST = [2, 3, 4, 5, 6];
let colsIdx = 1;

// 音声
let volume = 0, subBass = 0, bass = 0, mid = 0, treble = 0;
let rawSubBass = 0, rawBass = 0, rawMid = 0, rawTreble = 0;
let beatEnergy = 0, beatActive = false, beatCooldown = 0, beatRingAlpha = 0;
const HIST = 43;
const bassHist = new Float32Array(HIST);
let histIdx = 0;
let analyser, freqArray, timeArray;

// アニメ
let colorPhase = 0, distPhase = 0, distPhase2 = 0;
let hueBase = 0, hueJump = 0, tapFlash = 0;

// ── LUT ─────────────────────────────────────────────────
// lutX[i], lutY[i]: 出力ピクセルiが参照するカメラ座標
let lutX = null, lutY = null;

// ── オフスクリーン ───────────────────────────────────────
const camCvs = document.createElement('canvas');
const camCtx = camCvs.getContext('2d', { willReadFrequently: true });
const outCvs = document.createElement('canvas');
const outCtx = outCvs.getContext('2d');

// ── リサイズ ─────────────────────────────────────────────
function resize() {
  const wrap = canvasWrap.getBoundingClientRect();
  const s = Math.floor(Math.min(wrap.width, wrap.height));
  if (s === SIZE && canvas.width === SIZE) return;
  SIZE = s;
  canvas.width = canvas.height = SIZE;
  canvas.style.width = canvas.style.height = SIZE + 'px';
  beatRing.style.width = beatRing.style.height = SIZE + 'px';
  camCvs.width = camCvs.height = SIZE;
  outCvs.width = outCvs.height = SIZE;
  buildLUT();
}
window.addEventListener('resize', resize);
screen.orientation?.addEventListener('change', () => setTimeout(resize, 250));

// ══════════════════════════════════════════════════════════
// LUT構築 — ピクセル単位の三角形タイリング
//
// アイデア:
//   出力画像の各ピクセル(px,py)に対して
//   「どのカメラ座標を参照するか」を事前計算。
//
//   正三角形グリッドで画像を覆い、
//   各ピクセルが属するセルを(row, col, up/down)で特定。
//   セルの(row, col)のパリティと上下向きから
//   反転(flipX, flipY)を計算し、
//   基準三角形（中央）の対応座標を求める。
// ══════════════════════════════════════════════════════════
function buildLUT() {
  const W = SIZE;
  const cols = COLS_LIST[colsIdx];
  const side = W / cols;          // 三角形の辺長
  const H = side * Math.sqrt(3) / 2; // 三角形の高さ

  const N = W * W;
  lutX = new Float32Array(N);
  lutY = new Float32Array(N);

  // 基準セル: 中央の上向き三角形の重心
  const camCol = Math.floor(cols / 2);
  const camRow = Math.floor((W / H) / 2);
  // 上向き▲の重心: (col+0.5)*side, (row + 1/3)*H ... 実際は(row+2/3)*H に近い
  // ただし重心 = (上頂点 + 左下 + 右下) / 3
  // 上頂点: (col*side+side/2, row*H), 左下: (col*side, (row+1)*H), 右下: (col*side+side, (row+1)*H)
  const refCx = camCol * side + side / 2;
  const refCy = camRow * H + H * 2 / 3;

  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;

      // 円の外
      const dx = px - W / 2, dy = py - W / 2;
      if (dx * dx + dy * dy > (W / 2) * (W / 2)) {
        lutX[i] = -1; lutY[i] = -1;
        continue;
      }

      // グリッドセルを特定
      const col = Math.floor(px / side);
      const row = Math.floor(py / H);

      // セル内ローカル座標 (0〜1)
      const lx = (px - col * side) / side;
      const ly = (py - row * H) / H;

      // 上向き▲ or 下向き▽: 対角線 lx + ly = 1 で判別
      const isUp = (lx + ly <= 1.0);

      // セル重心
      const cellCx = col * side + side / 2;
      const cellCy = isUp
        ? row * H + H * 2 / 3  // 上▲の重心
        : row * H + H * 1 / 3; // 下▽の重心

      // 基準セルの重心からのオフセット
      const ox = px - cellCx;
      const oy = py - cellCy;

      // 行・列のパリティと向きで反転を決定
      // 正三角形タイリングでは隣接セルは辺で鏡映
      // 簡易的に: col偶奇でX反転、row偶奇でY反転、下向きでY追加反転
      const flipX = (col % 2 === 0) ? 1 : -1;
      let   flipY = (row % 2 === 0) ? 1 : -1;
      if (!isUp) flipY = -flipY;

      let sx = refCx + flipX * ox;
      let sy = refCy + flipY * oy;

      sx = Math.max(0, Math.min(W - 1, sx));
      sy = Math.max(0, Math.min(W - 1, sy));

      lutX[i] = sx;
      lutY[i] = sy;
    }
  }
}

// ── 起動 ─────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true; startBtn.textContent = '起動中...';
  try {
    const camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 640 } },
      audio: false
    });
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    video.srcObject = camStream; await video.play();
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') await actx.resume();
    analyser = actx.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.45; // 低いほど即応性UP
    actx.createMediaStreamSource(micStream).connect(analyser);
    freqArray = new Uint8Array(analyser.frequencyBinCount);
    timeArray = new Uint8Array(analyser.fftSize);
    startScreen.style.display = 'none'; mainView.style.display = 'flex';
    requestAnimationFrame(() => { resize(); updateUI(); running = true; requestAnimationFrame(loop); });
  } catch (e) {
    startBtn.disabled = false; startBtn.textContent = '起動する';
    startError.style.display = 'block';
    startError.textContent = 'カメラ/マイクへのアクセスが拒否されました。\n(' + e.message + ')';
  }
});

// ── コントロール ─────────────────────────────────────────
document.getElementById('btn-cols').addEventListener('click', () => {
  colsIdx = (colsIdx + 1) % COLS_LIST.length;
  buildLUT(); updateUI();
});
canvas.addEventListener('click', () => {
  colsIdx = (colsIdx + 1) % COLS_LIST.length;
  buildLUT(); tapFlash = 1.0; hueJump = 120 + Math.random()*120; updateUI();
});
canvas.addEventListener('touchend', e => {
  e.preventDefault();
  colsIdx = (colsIdx + 1) % COLS_LIST.length;
  buildLUT(); tapFlash = 1.0; hueJump = 120 + Math.random()*120; updateUI();
}, { passive: false });
function updateUI() {
  modeInfo.textContent = `△ ${COLS_LIST[colsIdx]} cols`;
}

// ── 音声解析 ─────────────────────────────────────────────
function analyzeAudio() {
  if (!analyser) return;
  analyser.getByteTimeDomainData(timeArray);
  analyser.getByteFrequencyData(freqArray);
  let sum = 0;
  for (let i=0;i<timeArray.length;i++){const v=(timeArray[i]-128)/128;sum+=v*v;}
  volume = volume*0.20 + Math.min(1,Math.sqrt(sum/timeArray.length)*12)*0.80; // 即応性UP+感度UP
  const bins=freqArray.length, hzPB=22050/bins;
  const b0=Math.round(80/hzPB),b1=Math.round(250/hzPB),b2=Math.round(800/hzPB);
  const b3=Math.round(2500/hzPB),b4=Math.round(6000/hzPB);
  let s0=0,s1=0,s3=0,s5=0;
  for(let i=0;i<b0;i++) s0+=freqArray[i];
  for(let i=b0;i<b1;i++) s1+=freqArray[i];
  for(let i=b2;i<b3;i++) s3+=freqArray[i];
  for(let i=b4;i<bins;i++) s5+=freqArray[i];
  rawSubBass=Math.min(1,(s0/Math.max(1,b0)/255)*6.5);   // 感度UP
  rawBass   =Math.min(1,(s1/Math.max(1,b1-b0)/255)*5.5);
  rawMid    =Math.min(1,(s3/Math.max(1,b3-b2)/255)*4.8);
  rawTreble =Math.min(1,(s5/Math.max(1,bins-b4)/255)*7.0);
  // スムージング係数を小さく → 即応性UP（0.xが新値、元の倍以上速い）
  subBass=subBass*0.25+rawSubBass*0.75; bass=bass*0.30+rawBass*0.70;
  mid=mid*0.35+rawMid*0.65; treble=treble*0.40+rawTreble*0.60;
  bassHist[histIdx++%HIST]=rawSubBass;
  let avg=0; for(let i=0;i<HIST;i++) avg+=bassHist[i]; avg/=HIST;
  if(beatCooldown>0) beatCooldown--;
  if(rawSubBass>0.25&&rawSubBass>avg*1.25&&beatCooldown===0){
    beatActive=true;beatEnergy=rawSubBass;beatCooldown=10;hueJump+=60+rawSubBass*160;
  } else beatActive=false;
  beatEnergy*=0.82;
  volFill.style.width=Math.round(volume*100)+'%';
  volNum.textContent=Math.round(volume*100);
}

// ── メインループ ─────────────────────────────────────────
function loop() {
  if (!running) return;
  analyzeAudio();

  colorPhase+=0.015+volume*0.15+bass*0.20;  // 位相速度UP
  distPhase +=0.045+mid*0.30+subBass*0.25;
  distPhase2+=0.030+treble*0.35+(bass+subBass)*0.15;
  hueBase   +=0.012+volume*0.08+bass*0.12;
  hueJump   *=0.92;

  if(beatActive) beatRingAlpha=1.0;
  if(beatRingAlpha>0.01){
    beatRingAlpha*=0.78;
    const hue=(hueBase*57)%360;
    beatRing.style.border=`3px solid hsla(${hue},100%,80%,${beatRingAlpha.toFixed(3)})`;
    beatRing.style.transform=`scale(${(1+(1-beatRingAlpha)*0.14).toFixed(4)})`;
  } else { beatRing.style.border='2px solid transparent'; beatRing.style.transform='scale(1)'; }

  if(video.readyState<2){requestAnimationFrame(loop);return;}

  const W=SIZE;
  const vw=video.videoWidth||640,vh=video.videoHeight||640,s=Math.min(vw,vh);
  const ez=1.0+subBass*0.35+beatEnergy*0.18;

  // カメラ映像 → camCvs
  camCtx.save();
  camCtx.clearRect(0,0,W,W);
  camCtx.translate(W/2,W/2); camCtx.scale(ez,ez); camCtx.translate(-W/2,-W/2);
  camCtx.drawImage(video,(vw-s)/2,(vh-s)/2,s,s,0,0,W,W);
  camCtx.restore();

  // ピクセル処理
  const camData=camCtx.getImageData(0,0,W,W);
  const cam=camData.data;
  const outData=camCtx.createImageData(W,W);
  const out=outData.data;

  const t=colorPhase;
  const waveStr=(rawSubBass*0.55+rawBass*0.40+rawMid*0.30)*W*0.20; // 歪み強度を大幅UP

  for(let py=0;py<W;py++){
    for(let px=0;px<W;px++){
      const i=py*W+px;
      let sx=lutX[i],sy=lutY[i];
      if(sx<0){out[i*4+3]=0;continue;}

      // 音声歪み（強度大幅UP）
      if(waveStr>0.5){
        const nx=px/W,ny=py/W;
        const ang=Math.atan2(ny-0.5,nx-0.5);
        const dist=Math.hypot(nx-0.5,ny-0.5);
        sx+=Math.sin(ny*6+distPhase)  *rawMid   *waveStr*2.0;  // 中音波: 2.0x
        sy+=Math.cos(nx*6+distPhase2) *rawMid   *waveStr*2.0;
        sx+=Math.sin(distPhase*1.5+ang*3)*dist  *rawSubBass*waveStr*3.5; // 低音渦: 3.5x
        sy+=Math.cos(distPhase*1.3+ang*3)*dist  *rawSubBass*waveStr*3.5;
        sx+=Math.sin((nx+ny)*10+distPhase2*2)*rawTreble*waveStr*1.5; // 高音細波: 1.5x
        sy+=Math.cos((nx-ny)*10+distPhase*2)*rawTreble*waveStr*1.5;
        sx=Math.max(0,Math.min(W-1,sx));
        sy=Math.max(0,Math.min(W-1,sy));
      }

      const si=(Math.round(sy)*W+Math.round(sx))*4;
      const r=cam[si],g=cam[si+1],b=cam[si+2];

      // 色変換（強度UP）
      const rMul=0.3+rawSubBass*3.5+rawBass*1.8+Math.sin(t)*1.2*rawMid;
      const gMul=0.3+mid*2.5+rawMid*2.0+Math.sin(t+2.1)*1.0*rawTreble;
      const bMul=0.3+treble*3.0+rawTreble*2.5+Math.sin(t+4.2)*1.0*rawBass;
      const cross=volume*0.90;
      const rAdd=Math.sin(t*1.1)*160*rawBass+beatEnergy*130;
      const gAdd=Math.sin(t*0.9+2.1)*130*rawMid;
      const bAdd=Math.sin(t*1.3+4.2)*160*rawTreble+beatEnergy*90;
      const r1=r*(1-cross)+g*cross*0.5+b*cross*0.5;
      const g1=g*(1-cross)+r*cross*0.3+b*cross*0.7;
      const b1=b*(1-cross)+r*cross*0.6+g*cross*0.4;
      const cl=v=>v<0?0:v>255?255:v|0;
      out[i*4]=cl(r1*rMul+rAdd);
      out[i*4+1]=cl(g1*gMul+gAdd);
      out[i*4+2]=cl(b1*bMul+bAdd);
      out[i*4+3]=255;
    }
  }

  // 描画
  ctx.clearRect(0,0,W,W);
  ctx.save();
  ctx.beginPath(); ctx.arc(W/2,W/2,W/2,0,Math.PI*2); ctx.clip();
  ctx.fillStyle='#000'; ctx.fillRect(0,0,W,W);
  outCtx.putImageData(outData,0,0);
  ctx.drawImage(outCvs,0,0);

  if(beatEnergy>0.02){
    const hue=(hueBase*57+hueJump)%360;
    ctx.globalCompositeOperation='screen'; ctx.globalAlpha=beatEnergy*0.75;
    const g=ctx.createRadialGradient(W/2,W/2,0,W/2,W/2,W/2);
    g.addColorStop(0,`hsla(${hue},100%,75%,1)`);
    g.addColorStop(0.5,`hsla(${(hue+60)%360},100%,60%,0.5)`);
    g.addColorStop(1,`hsla(${(hue+120)%360},100%,40%,0)`);
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(W/2,W/2,W/2,0,Math.PI*2); ctx.fill();
    ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=1;
  }
  if(tapFlash>0.02){
    ctx.globalAlpha=tapFlash*0.3;
    ctx.fillStyle=`hsl(${(hueBase*57+hueJump)%360},100%,80%)`;
    ctx.beginPath(); ctx.arc(W/2,W/2,W/2,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=1; tapFlash*=0.80;
  }
  ctx.restore();
  requestAnimationFrame(loop);
}

// ── PWA ─────────────────────────────────────────────────
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault();deferredPrompt=e;
  setTimeout(()=>{document.getElementById('install-banner').style.display='flex';},4000);
});
document.getElementById('install-btn')?.addEventListener('click',async()=>{
  if(!deferredPrompt)return;
  deferredPrompt.prompt();await deferredPrompt.userChoice;
  deferredPrompt=null;document.getElementById('install-banner').style.display='none';
});
document.getElementById('install-close')?.addEventListener('click',()=>{
  document.getElementById('install-banner').style.display='none';
});
if('serviceWorker' in navigator)
  window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(console.error));
