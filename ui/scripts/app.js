/* =============================================
   INFERNO HUD — app.js
   JG-Works Garage compatible
   ============================================= */
'use strict';

// ─── Canvas dial constants ────────────────────────────────────────────────────
const DEG    = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const CX = 100, CY = 100, R = 88;   // dial center & radius in 200x200 canvas

// ─── State ───────────────────────────────────────────────────────────────────
let curSpeed    = 0, tgtSpeed    = 0;
let curRpm      = 0;
let curFuel     = 1, curHealth   = 1;
let curGear     = 0;
let engineOn    = false;
let headlights  = 0;
let leftInd     = false, rightInd = false;
let seatbelt    = true;
let odoMiles    = 0;
let speedMode   = 1;   // 1=MPH default

// needle angles
let displaySpeedAngle = -130;
let targetSpeedAngle  = -130;
let animId = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const EL = {};

// ─── Blink timers ─────────────────────────────────────────────────────────────
const blinks = {};
function startBlink(el, ms) {
    if (!el || blinks[el.id]) return;
    let v = true;
    blinks[el.id] = setInterval(() => { v=!v; el.style.opacity = v?'1':'0.15'; }, ms);
}
function stopBlink(el) {
    if (!el || !blinks[el.id]) return;
    clearInterval(blinks[el.id]);
    delete blinks[el.id];
    el.style.opacity = '';
}

// ─── Sound (simple, no engine rumble) ────────────────────────────────────────
const AC = window.AudioContext || window.webkitAudioContext;
let ac = null;

function initAudio() {
    if (ac) return;
    try { ac = new AC(); } catch(_) {}
}

function playTone(freq, type, dur, vol) {
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol||0.12, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    o.start(); o.stop(ac.currentTime + dur + 0.01);
}

function playGearUp()    { playTone(660,'square',0.07,0.12); }
function playGearDown()  { playTone(330,'square',0.07,0.10); }
function playGearNeutral(){ playTone(220,'sine',0.1,0.08); }
function playRedline()   { playTone(1400,'sawtooth',0.06,0.09); setTimeout(()=>playTone(1600,'sawtooth',0.06,0.09),80); }
function playSeatbelt()  {
    [880,1100,880].forEach((f,i)=>setTimeout(()=>playTone(f,'sine',0.12,0.09),i*180));
}
function playLowFuel()   { [440,0,440].forEach((f,i)=>{ if(f) setTimeout(()=>playTone(f,'sine',0.15,0.08),i*300); }); }

let redlinePlayed = false;
let lastFuelWarn  = 0;
let lastGear      = -99;

// ─── Fire canvas ─────────────────────────────────────────────────────────────
// Realistic pixel fire simulation (Doom-style)
let fireCanvas, fireCtx, fireW, fireH;
let firePixels = [];
let fireIntensity = 0;     // 0..1 driven by speed
let fireRaf = null;

const FIRE_PALETTE = (function() {
    // Build a 37-color palette: black → dark red → red → orange → yellow → white
    const colors = [];
    const stops = [
        [0,   0,   0  ],
        [30,  0,   0  ],
        [80,  0,   0  ],
        [160, 20,  0  ],
        [220, 60,  0  ],
        [255, 100, 0  ],
        [255, 160, 20 ],
        [255, 220, 80 ],
        [255, 255, 180],
        [255, 255, 255],
    ];
    for (let i = 0; i < 37; i++) {
        const t   = i / 36;
        const si  = Math.min(Math.floor(t * (stops.length - 1)), stops.length - 2);
        const lt  = t * (stops.length - 1) - si;
        const r   = Math.round(stops[si][0] + lt * (stops[si+1][0] - stops[si][0]));
        const g   = Math.round(stops[si][1] + lt * (stops[si+1][1] - stops[si][1]));
        const b   = Math.round(stops[si][2] + lt * (stops[si+1][2] - stops[si][2]));
        colors.push([r, g, b]);
    }
    return colors;
})();

function initFire() {
    fireCanvas = document.getElementById('fire-canvas');
    const hud  = document.getElementById('hud');
    fireW = Math.max(1, Math.floor(hud.offsetWidth  / 4));
    fireH = Math.max(1, Math.floor(hud.offsetHeight / 4));
    if (fireW < 2 || fireH < 2) { fireW = 120; fireH = 20; }
    fireCanvas.width  = fireW;
    fireCanvas.height = fireH;
    fireCtx   = fireCanvas.getContext('2d');
    firePixels = new Uint8Array(fireW * fireH);
}

function spreadFire() {
    // Bottom row seeded by intensity
    for (let x = 0; x < fireW; x++) {
        const seed = Math.random() < fireIntensity
            ? Math.floor(fireIntensity * 36)
            : 0;
        firePixels[(fireH - 1) * fireW + x] = seed;
    }
    // Spread upward
    for (let y = 0; y < fireH - 1; y++) {
        for (let x = 0; x < fireW; x++) {
            const below = firePixels[(y + 1) * fireW + x];
            const wind  = Math.floor(Math.random() * 3) - 1;  // -1, 0, 1
            const decay = Math.floor(Math.random() * 2);
            const nx    = Math.max(0, Math.min(fireW - 1, x + wind));
            firePixels[y * fireW + nx] = Math.max(0, below - decay);
        }
    }
}

function renderFire() {
    if (!fireCtx) return;
    const img = fireCtx.createImageData(fireW, fireH);
    for (let i = 0; i < firePixels.length; i++) {
        const c   = FIRE_PALETTE[firePixels[i]];
        const idx = i * 4;
        img.data[idx]     = c[0];
        img.data[idx + 1] = c[1];
        img.data[idx + 2] = c[2];
        img.data[idx + 3] = firePixels[i] > 0 ? Math.min(255, firePixels[i] * 8) : 0;
    }
    fireCtx.putImageData(img, 0, 0);
}

function fireTick() {
    spreadFire();
    renderFire();
    fireRaf = requestAnimationFrame(fireTick);
}

// ─── Dial canvas ──────────────────────────────────────────────────────────────
let dialCanvas, dialCtx, dialBgCanvas, dialBgCtx;

function drawDialStatic() {
    const ctx = dialBgCtx;
    ctx.clearRect(0, 0, 200, 200);

    // Outer ring gradient
    const outerGrad = ctx.createRadialGradient(CX,CY,R-4,CX,CY,R+2);
    outerGrad.addColorStop(0, 'rgba(255,80,0,0.5)');
    outerGrad.addColorStop(1, 'rgba(255,20,0,0.05)');
    ctx.beginPath(); ctx.arc(CX,CY,R+1,0,TWO_PI);
    ctx.strokeStyle = outerGrad; ctx.lineWidth = 3; ctx.stroke();

    // Dial background
    const bg = ctx.createRadialGradient(CX,CY,0,CX,CY,R);
    bg.addColorStop(0,   'rgba(20,5,0,0.92)');
    bg.addColorStop(0.7, 'rgba(12,3,0,0.95)');
    bg.addColorStop(1,   'rgba(6,1,0,0.98)');
    ctx.beginPath(); ctx.arc(CX,CY,R,0,TWO_PI);
    ctx.fillStyle = bg; ctx.fill();

    // Zone arcs
    const zones = [
        { start:-130, end:-20,  color:'rgba(255,80,0,0.35)',  lw:5 },
        { start:-20,  end: 40,  color:'rgba(255,150,0,0.45)', lw:5 },
        { start: 40,  end: 110, color:'rgba(255,0,0,0.7)',    lw:5 },
    ];
    zones.forEach(z => {
        ctx.beginPath();
        ctx.arc(CX,CY,R-4, (z.start-90)*DEG, (z.end-90)*DEG, false);
        ctx.strokeStyle = z.color; ctx.lineWidth = z.lw;
        ctx.lineCap = 'round'; ctx.stroke();
    });

    // Tick marks
    for (let mph = 0; mph <= 200; mph += 10) {
        const angle = (mph * 1.2 - 130 - 90) * DEG;
        const isMaj = mph % 20 === 0;
        const or = R - 6;
        const ir = isMaj ? R - 18 : R - 13;
        ctx.save();
        ctx.translate(CX, CY);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(0, -or); ctx.lineTo(0, -ir);
        ctx.strokeStyle = isMaj ? 'rgba(255,180,80,0.7)' : 'rgba(255,100,40,0.3)';
        ctx.lineWidth   = isMaj ? 1.5 : 0.7;
        ctx.lineCap = 'butt'; ctx.stroke();
        ctx.restore();
    }

    // Speed labels
    ctx.font = 'bold 8px Orbitron, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let mph = 0; mph <= 200; mph += 40) {
        const angle = (mph * 1.2 - 130 - 90) * DEG;
        const lr = R - 26;
        const lx = CX + lr * Math.cos(angle);
        const ly = CY + lr * Math.sin(angle);
        ctx.fillStyle = mph >= 160 ? 'rgba(255,80,30,0.7)' : 'rgba(255,160,80,0.55)';
        ctx.fillText('' + mph, lx, ly);
    }

    // Inner decorative ring
    ctx.beginPath(); ctx.arc(CX,CY,R-2,0,TWO_PI);
    ctx.strokeStyle = 'rgba(255,50,0,0.18)'; ctx.lineWidth = 0.5; ctx.stroke();
}

function drawDialNeedle(speedAngle) {
    const ctx = dialCtx;
    ctx.clearRect(0, 0, 200, 200);
    ctx.drawImage(dialBgCanvas, 0, 0);

    const rad = (speedAngle - 90) * DEG;

    // Needle glow
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(rad);
    ctx.shadowColor = 'rgba(255,100,0,0.9)';
    ctx.shadowBlur  = 12;
    // Needle body
    const ng = ctx.createLinearGradient(0, 0, 0, -78);
    ng.addColorStop(0,   '#ff8800');
    ng.addColorStop(0.6, '#ff4400');
    ng.addColorStop(1,   '#ffcc00');
    ctx.beginPath();
    ctx.moveTo(-1.5, 8);
    ctx.lineTo(0, -78);
    ctx.lineTo(1.5, 8);
    ctx.closePath();
    ctx.fillStyle = ng;
    ctx.fill();
    ctx.restore();

    // Center cap
    const capGrad = ctx.createRadialGradient(CX,CY,0,CX,CY,9);
    capGrad.addColorStop(0,   '#ffcc00');
    capGrad.addColorStop(0.5, '#ff6600');
    capGrad.addColorStop(1,   '#cc2200');
    ctx.beginPath(); ctx.arc(CX,CY,9,0,TWO_PI);
    ctx.fillStyle = capGrad; ctx.fill();
    ctx.beginPath(); ctx.arc(CX,CY,3,0,TWO_PI);
    ctx.fillStyle = '#ffdd00'; ctx.fill();
}

// ─── Needle animation ─────────────────────────────────────────────────────────
let lastTs = 0;
let needleRunning = false;

function needleTick(ts) {
    const dt   = Math.min((ts - lastTs) / 1000, 0.1);
    lastTs     = ts;
    const diff = targetSpeedAngle - displaySpeedAngle;
    const decay = 8 * dt / (1 + 8 * dt);
    if (Math.abs(diff) > 0.2) {
        displaySpeedAngle += diff * decay;
    } else {
        displaySpeedAngle = targetSpeedAngle;
        needleRunning = false;
    }
    drawDialNeedle(displaySpeedAngle);
    if (needleRunning) requestAnimationFrame(needleTick);
}

function startNeedle() {
    if (!needleRunning) {
        needleRunning = true;
        lastTs = performance.now();
        requestAnimationFrame(needleTick);
    }
}

// ─── Speed display helpers ────────────────────────────────────────────────────
function applySpeedColor(spd) {
    if (!EL.speedNum) return;
    EL.speedNum.classList.remove('s-slow','s-med','s-fast','s-max');
    if      (spd < 50)  EL.speedNum.classList.add('s-slow');
    else if (spd < 100) EL.speedNum.classList.add('s-med');
    else if (spd < 150) EL.speedNum.classList.add('s-fast');
    else                EL.speedNum.classList.add('s-max');

    // Redline sound
    if (spd >= 150 && !redlinePlayed) { playRedline(); redlinePlayed = true; }
    else if (spd < 140) redlinePlayed = false;

    // Fire intensity 0..1
    fireIntensity = Math.min(1, spd / 160);
}

// ─── Bar helper ───────────────────────────────────────────────────────────────
function setBar(barEl, valEl, ratio, type) {
    if (!barEl) return;
    const pct = Math.max(0, Math.min(1, ratio));
    barEl.style.width = (pct * 100).toFixed(1) + '%';
    if (valEl) valEl.textContent = Math.round(pct * 100) + '%';
    if (pct <= 0.15) barEl.classList.add('low');
    else             barEl.classList.remove('low');

    // Low warnings
    if (type === 'fuel' && pct <= 0.15) {
        const now = Date.now();
        if (now - lastFuelWarn > 8000) { playLowFuel(); lastFuelWarn = now; }
    }
}

// ─── Dot / pill helpers ───────────────────────────────────────────────────────
function setDot(dotId, lblId, state, onText, offText, warnMode) {
    const dot = document.getElementById(dotId);
    const lbl = document.getElementById(lblId);
    if (dot) { dot.className = 'pill-dot ' + (state ? (warnMode?'warn':'on') : 'off'); }
    if (lbl) { lbl.className = 'pill-text ' + (state ? (warnMode?'warn':'on') : 'off'); lbl.textContent = state ? onText : offText; }
}

// =============================================
// GLOBAL FUNCTIONS — called by JG-Works server
// =============================================

function setEngine(state) {
    engineOn = !!state;
    setDot('engine-dot','engine-lbl', engineOn, 'ON', 'OFF');
    const warn = document.getElementById('ind-engine-warn');
    if (warn) warn.classList.toggle('active', !engineOn && curSpeed > 0);
}

function setSpeed(speed) {
    initAudio();
    const raw = Number(speed) || 0;
    let displaySpd;
    switch (speedMode) {
        case 0:  displaySpd = Math.round(raw * 3.6);       break; // KMH
        case 2:  displaySpd = Math.round(raw * 1.943844);  break; // Knots
        default: displaySpd = Math.round(raw * 2.236936);         // MPH
    }
    tgtSpeed = displaySpd;
    if (EL.speedNum) EL.speedNum.textContent = displaySpd;
    applySpeedColor(displaySpd);

    const angle = Math.min(Math.max(displaySpd, 0), 200) * 1.2 - 130;
    targetSpeedAngle = isNaN(angle) ? -130 : angle;
    startNeedle();
}

function setRPM(rpm) {
    curRpm = Math.max(0, Math.min(1, Number(rpm) || 0));
    if (EL.rpmBar) {
        EL.rpmBar.style.width = (curRpm * 100).toFixed(1) + '%';
        // Color shift: green→orange→red
        if      (curRpm < 0.6) EL.rpmBar.style.background = 'linear-gradient(90deg,#ff2200,#ff6600,#ffdd00)';
        else if (curRpm < 0.8) EL.rpmBar.style.background = 'linear-gradient(90deg,#ff4400,#ff8800)';
        else                   EL.rpmBar.style.background = 'linear-gradient(90deg,#cc0000,#ff2200)';
    }
}

function setFuel(fuel) {
    const n = Number(fuel);
    curFuel = isNaN(n) ? 0 : (n > 1 ? n/100 : n);
    setBar(EL.fuelBar, EL.fuelVal, curFuel, 'fuel');
    const pill = document.getElementById('pill-fuel');
    if (pill) pill.classList.toggle('active', curFuel > 0.3);
}

function setHealth(health) {
    const n = Number(health);
    curHealth = isNaN(n) ? 0 : (n > 1 ? n/100 : n);
    setBar(EL.healthBar, EL.healthVal, curHealth, 'health');
    const pill = document.getElementById('pill-health');
    if (pill) pill.classList.toggle('active', curHealth > 0.5);
}

function setGear(gear) {
    const g = Number(gear) || 0;
    // Sound on gear change
    if (g !== lastGear && lastGear !== -99) {
        if (g === 0)       playGearNeutral();
        else if (g > lastGear) playGearUp();
        else               playGearDown();
    }
    lastGear = g;
    curGear  = g;
    if (!EL.gearBadge) return;
    EL.gearBadge.textContent = g === 0 ? 'N' : (g === -1 ? 'R' : String(g));
    if (g === 0)      { EL.gearBadge.style.color = '#66aaff'; EL.gearBadge.style.textShadow = '0 0 10px #4488ff'; }
    else if (g >= 5)  { EL.gearBadge.style.color = '#ff4400'; EL.gearBadge.style.textShadow = '0 0 10px #ff2200'; }
    else              { EL.gearBadge.style.color = '#ffdd00'; EL.gearBadge.style.textShadow = '0 0 10px #ff6600, 0 0 22px #ff2200'; }
}

function setHeadlights(state) {
    headlights = Number(state) || 0;
    const on = headlights > 0;
    setDot('lights-dot','lights-lbl', on, headlights >= 2 ? 'HIGH' : 'ON', 'OFF');
    const icon = document.getElementById('ind-lights');
    if (icon) icon.classList.toggle('active', on);
}

function setLeftIndicator(state) {
    leftInd = !!state;
    const el = document.getElementById('ind-left');
    const pill = document.getElementById('pill-ind-left');
    setDot('left-dot','left-lbl', leftInd, 'LEFT', 'LEFT');
    if (el) { el.classList.toggle('active', leftInd); leftInd ? startBlink(el, 500) : stopBlink(el); }
    if (pill) pill.classList.toggle('active', leftInd);
}

function setRightIndicator(state) {
    rightInd = !!state;
    const el = document.getElementById('ind-right');
    const pill = document.getElementById('pill-ind-right');
    setDot('right-dot','right-lbl', rightInd, 'RIGHT', 'RIGHT');
    if (el) { el.classList.toggle('active', rightInd); rightInd ? startBlink(el, 500) : stopBlink(el); }
    if (pill) pill.classList.toggle('active', rightInd);
}

function setSeatbelts(state) {
    seatbelt = !!state;
    const warn = !seatbelt;
    setDot('seatbelt-dot','seatbelt-lbl', !warn, 'BELT ON', 'NO BELT', warn);
    const pill = document.getElementById('pill-seatbelt');
    if (pill) { pill.classList.toggle('active', !warn); }
    if (warn) playSeatbelt();
}

function setSpeedMode(mode) {
    speedMode = Number(mode) || 1;
    const labels = ['KMH','MPH','KTS'];
    if (EL.speedUnit) EL.speedUnit.textContent = labels[speedMode] || 'MPH';
    const lbl = document.getElementById('mode-lbl');
    if (lbl) lbl.textContent = labels[speedMode] || 'MPH';
}

function setOdometer(distance) {
    odoMiles = Number(distance) || 0;
    if (EL.odoVal) EL.odoVal.textContent = odoMiles.toFixed(1) + ' mi';
}

// ─── NUI / postMessage bridge ─────────────────────────────────────────────────
function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number')  return v !== 0;
    const s = String(v).trim().toLowerCase();
    return !['false','0','off','no'].includes(s);
}

function applyTelemetry(data) {
    if (!data || typeof data !== 'object') return;
    const d = (data.data && typeof data.data === 'object') ? data.data : data;
    if (d.speed    !== undefined) { let s=Number(d.speed); const u=String(d.speedUnit||d.unit||'').toLowerCase(); if(u==='km/h'||u==='kmh'||u==='kph') s/=3.6; else if(u==='mph') s/=2.236936; setSpeed(s); }
    if (d.rpm      !== undefined) setRPM(d.rpm);
    if (d.fuel     !== undefined) setFuel(d.fuel);
    if (d.health   !== undefined) setHealth(d.health);
    if (d.gear     !== undefined) setGear(d.gear);
    if (d.engine   !== undefined) setEngine(toBool(d.engine));
    if (d.headlights !== undefined) setHeadlights(Number(d.headlights)||0);
    if (d.leftIndicator  !== undefined || d.left  !== undefined) setLeftIndicator(toBool(d.leftIndicator??d.left));
    if (d.rightIndicator !== undefined || d.right !== undefined) setRightIndicator(toBool(d.rightIndicator??d.right));
    if (d.seatbelt !== undefined || d.seatbeltFastened !== undefined) setSeatbelts(toBool(d.seatbelt??d.seatbeltFastened));
    if (d.odometer !== undefined) setOdometer(d.odometer);
}

window.addEventListener('message', e => {
    try {
        const data = e && e.data;
        if (!data) return;
        if (typeof data === 'string') { try { applyTelemetry(JSON.parse(data)); } catch(_){} return; }
        const action = typeof data.action === 'string' ? data.action.toLowerCase() : '';
        if (['vehicle','speedometer','update','telemetry'].includes(action) ||
            data.speed !== undefined || data.rpm !== undefined) applyTelemetry(data);
    } catch(e) { console.error('[INFERNO HUD]', e); }
});

// ─── Scale & drag ─────────────────────────────────────────────────────────────
let scale = 1.0;
let hudEl  = null;

function savePos() {
    if (!hudEl) return;
    const s = window.getComputedStyle(hudEl);
    localStorage.setItem('inferno_hud', JSON.stringify({
        scale, left: parseFloat(s.left)||null, bottom: parseFloat(s.bottom)||18
    }));
}

function loadPos() {
    hudEl = document.getElementById('hud');
    if (!hudEl) return;
    try {
        const p = JSON.parse(localStorage.getItem('inferno_hud'));
        if (!p) return;
        scale = typeof p.scale === 'number' ? p.scale : 1.0;
        hudEl.style.transform = `translateX(-50%) scale(${scale})`;
        if (typeof p.left === 'number') {
            hudEl.style.left   = p.left + 'px';
            hudEl.style.transform = `scale(${scale})`;
        }
    } catch(_) {}
}

function setupControls() {
    document.getElementById('btn-plus')?.addEventListener('click', e => {
        e.stopPropagation(); scale = Math.min(scale+0.1,2.0);
        hudEl.style.transform = `translateX(-50%) scale(${scale})`; savePos();
    });
    document.getElementById('btn-minus')?.addEventListener('click', e => {
        e.stopPropagation(); scale = Math.max(scale-0.1,0.5);
        hudEl.style.transform = `translateX(-50%) scale(${scale})`; savePos();
    });
    document.getElementById('btn-reset')?.addEventListener('click', e => {
        e.stopPropagation(); scale = 1.0;
        hudEl.style.cssText = ''; localStorage.removeItem('inferno_hud');
    });
}

function setupDrag() {
    const el = document.getElementById('hud');
    if (!el) return;
    let drag=false, sx=0, sy=0, ix=0, iy=0, raf=null;
    el.addEventListener('pointerdown', e => {
        if (e.target.closest('.ctrl-btn')) return;
        drag=true; ix=el.offsetLeft; iy=el.offsetTop; sx=e.clientX; sy=e.clientY;
        el.setPointerCapture(e.pointerId); e.preventDefault();
    });
    el.addEventListener('pointermove', e => {
        if (!drag||raf) return;
        const nx=e.clientX, ny=e.clientY;
        raf=requestAnimationFrame(()=>{
            el.style.left=`${ix+nx-sx}px`; el.style.top=`${iy+ny-sy}px`;
            el.style.bottom='auto'; el.style.transform=`scale(${scale})`;
            raf=null;
        });
    });
    el.addEventListener('pointerup', e => {
        drag=false; el.releasePointerCapture(e.pointerId); savePos();
    });
}

// ─── DOM Ready ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    EL.speedNum  = document.getElementById('speed-num');
    EL.speedUnit = document.getElementById('speed-unit');
    EL.gearBadge = document.getElementById('gear-badge');
    EL.rpmBar    = document.getElementById('rpm-bar');
    EL.fuelBar   = document.getElementById('fuel-bar');
    EL.fuelVal   = document.getElementById('fuel-val');
    EL.healthBar = document.getElementById('health-bar');
    EL.healthVal = document.getElementById('health-val');
    EL.odoVal    = document.getElementById('odo-val');
    hudEl        = document.getElementById('hud');

    // Init dial canvas
    dialCanvas   = document.getElementById('dial-canvas');
    dialCtx      = dialCanvas.getContext('2d');
    dialBgCanvas = document.createElement('canvas');
    dialBgCanvas.width = dialBgCanvas.height = 200;
    dialBgCtx    = dialBgCanvas.getContext('2d');

    document.fonts.ready.then(() => {
        drawDialStatic();
        drawDialNeedle(-130);
    });

    // Init fire
    requestAnimationFrame(() => {
        initFire();
        fireRaf = requestAnimationFrame(fireTick);
    });

    loadPos();
    setupControls();
    setupDrag();

    // Show HUD
    const hud = document.getElementById('hud');
    if (hud) hud.classList.remove('hidden');

    // Audio init on interaction
    ['click','pointerdown'].forEach(ev =>
        document.addEventListener(ev, initAudio, { once:true })
    );

    // ─── Dev Preview ─────────────────────────────────────────────────────────
    if (typeof window.invokeNative === 'undefined') {
        initAudio();
        let ps=0, dir=1;
        setEngine(true); setSeatbelts(true); setOdometer(372.1);
        setInterval(() => {
            ps += dir * 4;
            if (ps >= 220) dir = -1;
            if (ps <= 0)   dir =  1;
            setSpeed(ps / 3.6);
            setRPM(Math.min(1, ps/220));
            setGear(Math.min(6, Math.max(1, Math.floor(ps/37))));
            setFuel(0.65); setHealth(0.88);
        }, 50);
    }
});

// Expose API
window.SAMCSpeedo = { setSpeed,setRPM,setFuel,setHealth,setGear,setEngine,setHeadlights,setLeftIndicator,setRightIndicator,setSeatbelts,setOdometer,setSpeedMode };
