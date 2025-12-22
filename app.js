// Default Settings
const DEFAULT_SETTINGS = {
    fps: 12,
    motionThreshold: 0.20,
    jitterIntensity: 10,
    hueShift: 0.4,
    saturation: 1.2,
    brightness: 1.2,
    contrast: 0.9,
    noise: 35,
    scanlineIntensity: 0.2,
    trackingNoise: 0.3,
    curvature: -0.05,
    blur: 0.5,
    sharpen: 1.0,
    bloom: 1.0,
    interlace: 0.2,
    quality: 360,
    zoom: 1.0,
    aspectRatio: '4:3',
    orientation: 'auto',
    sourceResolution: '480p',
    autoSave: 'off',
    saveMode: 'auto',
    audioHiss: 0.2,
    audioDistortion: 0.3,
    colorDepth: 50,
    lensFringe: 2.0,
    vignette: 0.2,
    colorBleed: 0,
    vertRoll: 0.0,
    lensDamage: 0.1,
    hWave: 1,
    dateStamp: 'off'
};

// Application State
const state = {
    streamActive: false,
    hasError: null,
    capturedImage: null,
    capturedVideo: null,
    flashOn: false,
    isRecording: false,
    isLocked: false,
    showSettings: false,
    flashMode: 'auto', // auto, on, off
    cameraFacing: 'environment',
    isDevicePortrait: true, // Will be updated in init
    settings: { ...DEFAULT_SETTINGS },
    currentLuma: 0,
    flashActiveFrame: false, // triggers whiteout in processFrame
    rollOffset: 0,         // Current vertical pixel offset
    damageCanvas: null,    // Offscreen canvas for unique dust
    uniqueSeed: null,      // User's unique hash
    waveTimer: 0
};

// Internal Logic Variables
let animationFrameId = null;
let audioStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let previousRawFrameData = null;
let lastRenderWidth = 0;
let lastRenderHeight = 0;
let jitterSustain = 0;
let pressTimer = null;
let touchStartY = 0;
let lastFrameTime = 0;
let currentSourceRes = '720p';
let db = null; // IndexedDB instance

// Audio Context Global
let audioCtx = null;
let audioDest = null;
let micSource = null;
let hissNode = null;
let hissGain = null;
let distNode = null;
let audioStreamProcessed = null;

// Pinch Zoom Variables
let initialPinchDist = 0;
let initialPinchZoom = 1.0;

const LONG_PRESS_MS = 300;
const STORAGE_KEY = 'twosies_settings_v1';
const DB_NAME = 'twosies_db';
const STORE_NAME = 'backups';

// DOM Elements
const els = {
    video: document.getElementById('videoElement'),
    canvas: document.getElementById('canvasElement'),
    viewfinder: document.getElementById('viewfinder'),
    settingsModal: document.getElementById('modal-settings'),
    settingsContainer: document.getElementById('settings-container'),
    flashIcon: document.getElementById('icon-flash'),
    flashOffSlash: document.getElementById('flash-off-slash'),
    flashAutoText: document.getElementById('flash-auto-text'),
    recIndicator: document.getElementById('indicator-rec'),
    recStateText: document.getElementById('text-rec-state'),
    zoomIndicator: document.getElementById('indicator-zoom'),
    errorDisplay: document.getElementById('error-display'),
    errorMessage: document.getElementById('error-message'),
    canvasContainer: document.getElementById('canvas-container'),
    resultPhoto: document.getElementById('result-photo'),
    resultImg: document.getElementById('result-img'),
    resultVideo: document.getElementById('result-video'),
    resultVid: document.getElementById('result-vid'),
    flashOverlay: document.getElementById('flash-overlay'),
    counterText: document.getElementById('counter-text'),
    controlsCapture: document.getElementById('controls-capture'),
    controlsReview: document.getElementById('controls-review'),
    btnShutter: document.getElementById('btn-shutter'),
    shutterInner: document.getElementById('shutter-inner'),
    shutterOuter: document.getElementById('shutter-outer'),
    btnStopLock: document.getElementById('btn-stop-lock'),
    containerShutter: document.getElementById('container-shutter'),
    hintLock: document.getElementById('hint-lock'),
    btnFlip: document.getElementById('btn-flip'),
    btnFlash: document.getElementById('btn-flash'),
    btnSettings: document.getElementById('btn-settings'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    btnTrash: document.getElementById('btn-trash'),
    btnSave: document.getElementById('btn-save'),
    backupsSection: document.getElementById('backups-section'),
    backupsList: document.getElementById('backups-list')
};

// --- Initialization ---

function init() {
    loadSettings();
    initDB(); // Initialize IndexedDB
    detectOrientation();

    // Orientation & Resize Listeners
    if (screen.orientation) {
        screen.orientation.addEventListener('change', () => {
            detectOrientation();
            updateUI();
        });
    }
    window.addEventListener('resize', () => {
        detectOrientation();
        updateUI();
    });

    renderSettingsUI();
    setupEventListeners();
    startCamera();
    updateUI();
}

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            state.settings = { ...DEFAULT_SETTINGS, ...parsed };
            currentSourceRes = state.settings.sourceResolution;
        }
    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch (e) {
        console.error('Failed to save settings', e);
    }
}

// --- IndexedDB Logic ---

function initDB() {
    const request = indexedDB.open(DB_NAME, 1);
    
    request.onerror = (e) => console.error("DB Error", e);
    
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
    };
    
    request.onsuccess = (e) => {
        db = e.target.result;
        deleteOldBackups(); // Cleanup on init
    };
}

function saveToBackup(blob, type) {
    if (!db) return;
    
    const item = {
        id: Date.now(),
        type: type,
        blob: blob,
        date: new Date()
    };
    
    const tx = db.transaction([STORE_NAME], "readwrite");
    tx.objectStore(STORE_NAME).add(item);
}

function deleteOldBackups() {
    if (!db) return;
    const tx = db.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    const request = store.getAll();
    request.onsuccess = () => {
        const items = request.result;
        items.forEach(item => {
            if (item.id < thirtyDaysAgo) {
                store.delete(item.id);
            }
        });
    };
}

function loadBackupsUI() {
    if (!db) return;
    els.backupsSection.classList.remove('hidden');
    els.backupsList.innerHTML = 'Loading...';
    
    const tx = db.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    
    request.onsuccess = () => {
        const items = request.result.sort((a, b) => b.id - a.id); // Newest first
        els.backupsList.innerHTML = '';
        
        if (items.length === 0) {
            els.backupsList.innerHTML = '<div style="grid-column: span 3; color: #555; text-align: center; padding: 1rem;">NO BACKUPS FOUND</div>';
            return;
        }

        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'backup-item';
            
            const url = URL.createObjectURL(item.blob);
            
            if (item.type === 'image') {
                const img = document.createElement('img');
                img.src = url;
                img.className = 'backup-thumb';
                div.appendChild(img);
            } else {
                const vid = document.createElement('video');
                vid.src = url;
                vid.className = 'backup-thumb';
                vid.muted = true;
                div.appendChild(vid);
                
                const icon = document.createElement('div');
                icon.className = 'backup-video-icon';
                div.appendChild(icon);
            }
            
            div.onclick = () => {
                // Restore logic
                if (item.type === 'image') {
                    state.capturedImage = url;
                    state.capturedVideo = null;
                } else {
                    state.capturedVideo = url;
                    state.capturedImage = null;
                }
                toggleSettings(); // Close settings
                updateUI();
            };
            
            els.backupsList.appendChild(div);
        });
    };
}


// --- Hardware Logic ---

function detectOrientation() {
    if (screen.orientation && screen.orientation.type) {
        state.isDevicePortrait = screen.orientation.type.includes('portrait');
    } else {
        state.isDevicePortrait = window.innerHeight > window.innerWidth;
    }
}

function setupEventListeners() {
    els.btnFlash.onclick = toggleFlash;
    els.btnSettings.onclick = toggleSettings;
    els.btnCloseSettings.onclick = toggleSettings;
    els.btnFlip.onclick = toggleCamera;
    els.btnTrash.onclick = retake;
    els.btnSave.onclick = download;
    els.btnStopLock.onclick = stopRecording;

    // Shutter interactions
    const start = (e) => startPress(e);
    const end = (e) => endPress(e);
    const move = (e) => handleTouchMove(e);

    els.btnShutter.addEventListener('mousedown', start);
    els.btnShutter.addEventListener('touchstart', start);
    
    els.btnShutter.addEventListener('mouseup', end);
    els.btnShutter.addEventListener('mouseleave', end);
    els.btnShutter.addEventListener('touchend', end);
    
    // Pinch Zoom detection on viewfinder as well
    els.viewfinder.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            initialPinchDist = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            initialPinchZoom = state.settings.zoom;
        }
    });

    els.viewfinder.addEventListener('touchmove', (e) => handlePinchMove(e));
    
    // Also attach to shutter for dragging lock, but propagate pinch
    els.btnShutter.addEventListener('touchmove', move);
}

function handlePinchMove(e) {
    if (e.touches.length === 2 && initialPinchDist > 0) {
        const dist = Math.hypot(
            e.touches[0].pageX - e.touches[1].pageX,
            e.touches[0].pageY - e.touches[1].pageY
        );
        
        const scale = dist / initialPinchDist;
        let newZoom = initialPinchZoom * scale;
        
        // Clamp
        newZoom = Math.max(1.0, Math.min(4.0, newZoom));
        state.settings.zoom = parseFloat(newZoom.toFixed(1));
        
        // Update UI logic
        els.zoomIndicator.textContent = state.settings.zoom + 'x';
        els.zoomIndicator.classList.remove('hidden');
        
        // Debounce saving settings
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
             saveSettings();
             els.zoomIndicator.classList.add('hidden');
        }, 1000);
    }
}

async function startCamera() {
    state.hasError = null;
    updateUI();

    const resolutionConstraints = getConstraintsForResolution(state.settings.sourceResolution);
    const constraints = {
        video: {
            ...resolutionConstraints,
            facingMode: { ideal: state.cameraFacing },
            frameRate: { ideal: 30 }
        },
        audio: true
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        initStream(stream);
    } catch (err) {
        console.warn('Initial camera constraint failed', err);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { ...resolutionConstraints },
                audio: true
            });
            initStream(stream);
        } catch (videoErr) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                initStream(stream);
            } catch (finalErr) {
                console.error('Camera failed', finalErr);
                state.hasError = 'CAMERA MALFUNCTION';
                updateUI();
            }
        }
    }
}

// --- Audio Processing for Retro Effect ---

function makeDistortionCurve(amount) {
    const k = amount * 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
        const x = i * 2 / n_samples - 1;
        // Soft clipping curve
        if (amount === 0) curve[i] = x;
        else curve[i] = (Math.PI + k) * x / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

function setupAudioGraph(inStream) {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    
    // Cleanup old graph
    if (micSource) { try { micSource.disconnect(); } catch(e){} }
    if (hissNode) { try { hissNode.stop(); hissNode.disconnect(); } catch(e){} }
    if (hissGain) { try { hissGain.disconnect(); } catch(e){} }
    
    // Create Destination
    if (!audioDest) audioDest = audioCtx.createMediaStreamDestination();
    
    // Source
    micSource = audioCtx.createMediaStreamSource(inStream);
    
    // --- Processing Chain ---
    
    // 1. Bandpass (Lo-fi Mic simulation)
    const lowPass = audioCtx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 3500; // Cut high fidelity
    
    const highPass = audioCtx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 300; // Cut low rumble
    
    // 2. Distortion / Saturation
    distNode = audioCtx.createWaveShaper();
    distNode.curve = makeDistortionCurve(state.settings.audioDistortion);
    distNode.oversample = 'none';

    // 3. Compression (Leveling)
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;

    // Connect Mic Path
    micSource.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(distNode);
    distNode.connect(compressor);
    compressor.connect(audioDest);
    
    // --- Hiss Generator ---
    const bufferSize = audioCtx.sampleRate * 2;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    
    let lastOut = 0; // Initialize before loop

    // Pink-ish noise approximation
    for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        data[i] = (lastOut + (0.02 * white)) / 1.02;
        lastOut = data[i];
        data[i] *= 3.5; // Compensate gain
    }
    
    hissNode = audioCtx.createBufferSource();
    hissNode.buffer = buffer;
    hissNode.loop = true;
    hissNode.start();
    
    hissGain = audioCtx.createGain();
    hissGain.gain.value = state.settings.audioHiss * 0.05; // Base level scale
    hissNode.connect(hissGain);
    hissGain.connect(audioDest);
    
    audioStreamProcessed = audioDest.stream;
}

function updateAudioParams() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    
    if (hissGain) {
        // Logarithmic adjustment feels better for volume
        hissGain.gain.setTargetAtTime(state.settings.audioHiss * 0.05, audioCtx.currentTime, 0.1);
    }
    if (distNode) {
        distNode.curve = makeDistortionCurve(state.settings.audioDistortion);
    }
}


function initStream(stream) {
    state.streamActive = true;
    
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
        audioStream = new MediaStream(audioTracks);
        // Initialize Retro Audio Processing
        setupAudioGraph(audioStream);
    }

    // Assign to video element
    els.video.srcObject = stream;
    
    els.video.onloadedmetadata = () => {
        els.video.play().catch(e => console.error('Play error', e));
        // Only start loop if not already running (seamless switching)
        if (!animationFrameId) startProcessingLoop();
    };
    updateUI();
}

function stopCamera(stopAudio = true) {
    if (els.video.srcObject) {
        const tracks = els.video.srcObject.getTracks();
        tracks.forEach(track => {
            track.stop(); // Hardware release
        });
        els.video.srcObject = null; // DOM release
    }
    state.streamActive = false;
}

async function toggleCamera() {
    // Seamless switch logic
    state.cameraFacing = state.cameraFacing === 'environment' ? 'user' : 'environment';

    if (els.video.srcObject) {
        els.video.srcObject.getTracks().forEach(t => t.stop());
    }
    
    try {
        const resolutionConstraints = getConstraintsForResolution(state.settings.sourceResolution);
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                ...resolutionConstraints,
                facingMode: { ideal: state.cameraFacing }
            },
            audio: true 
        });
        
        // Re-init audio with new stream
        if (newStream.getAudioTracks().length > 0) {
            audioStream = new MediaStream(newStream.getAudioTracks());
            setupAudioGraph(audioStream);
        }
        
        els.video.srcObject = newStream;
        els.video.play();

    } catch (e) {
        console.error("Failed to switch camera", e);
        state.hasError = "LENS ERROR";
        updateUI();
    }
}

function toggleFlash() {
    const modes = ['auto', 'on', 'off'];
    const idx = modes.indexOf(state.flashMode);
    state.flashMode = modes[(idx + 1) % modes.length];
    updateUI();
}

function getConstraintsForResolution(res) {
    switch (res) {
        case '480p': return { width: { ideal: 640 }, height: { ideal: 480 } };
        case '720p': return { width: { ideal: 1280 }, height: { ideal: 720 } };
        case '1080p': return { width: { ideal: 1920 }, height: { ideal: 1080 } };
        default: return { width: { ideal: 1280 }, height: { ideal: 720 } };
    }
}

// --- Frame Processing ---

function startProcessingLoop() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    const loop = (timestamp) => {
        const currentFPS = state.settings.fps;
        const frameInterval = 1000 / currentFPS;
        const elapsed = timestamp - lastFrameTime;

        if (!state.capturedImage && !state.capturedVideo) {
            if (elapsed > frameInterval) {
                lastFrameTime = timestamp - (elapsed % frameInterval);
                processFrame();
            }
        }
        animationFrameId = requestAnimationFrame(loop);
    };
    animationFrameId = requestAnimationFrame(loop);
}

function calculateTargetDimensions() {
    const s = state.settings;
    const [aspectW, aspectH] = s.aspectRatio.split(':').map(Number);
    let ratio = aspectW / aspectH;
    
    // In "auto" orientation mode, we flip the ratio if the device is portrait
    let isPortrait = s.orientation === 'auto' ? state.isDevicePortrait : s.orientation === 'portrait';

    if (isPortrait && ratio > 1) ratio = 1 / ratio;
    else if (!isPortrait && ratio < 1) ratio = 1 / ratio;

    let w, h;
    if (ratio >= 1) {
        w = s.quality;
        h = Math.round(s.quality / ratio);
    } else {
        h = s.quality;
        w = Math.round(s.quality * ratio);
    }

    return { 
        width: Math.floor(w / 2) * 2, 
        height: Math.floor(h / 2) * 2 
    };
}

function resizeBuffer(src, sw, sh, dw, dh) {
    const dst = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const sy = Math.floor(y * sh / dh);
        for (let x = 0; x < dw; x++) {
            const sx = Math.floor(x * sw / dw);
            const sIdx = (sy * sw + sx) * 4;
            const dIdx = (y * dw + x) * 4;
            dst[dIdx] = src[sIdx];
            dst[dIdx+1] = src[sIdx+1];
            dst[dIdx+2] = src[sIdx+2];
            dst[dIdx+3] = src[sIdx+3];
        }
    }
    return dst;
}

function processFrame() {
    const video = els.video;
    // Handle video not ready
    if (video.readyState < 2) return;

    const canvas = els.canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const s = state.settings;

    const { width: renderW, height: renderH } = calculateTargetDimensions();

    if (canvas.width !== renderW || canvas.height !== renderH) {
        if (previousRawFrameData && lastRenderWidth > 0) {
            previousRawFrameData = resizeBuffer(previousRawFrameData, lastRenderWidth, lastRenderHeight, renderW, renderH);
        } else {
            previousRawFrameData = null;
        }
        canvas.width = renderW;
        canvas.height = renderH;
        lastRenderWidth = renderW;
        lastRenderHeight = renderH;
        
        updateViewfinderAspect(s.aspectRatio, s.orientation);
        
        // Regenerate damage map if resolution changed
        state.damageCanvas = generateDamageMap(renderW, renderH);
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sourceAspect = vw / vh;
    const targetAspect = renderW / renderH;

    let cropW = vw, cropH = vh;

    if (targetAspect > sourceAspect) {
        cropH = vw / targetAspect;
    } else {
        cropW = vh * targetAspect;
    }

    cropW /= s.zoom;
    cropH /= s.zoom;

    const cropX = (vw - cropW) / 2;
    const cropY = (vh - cropH) / 2;

    ctx.filter = 'none';
    ctx.imageSmoothingEnabled = true;

    if (state.cameraFacing === 'user') {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(video, cropX, cropY, cropW, cropH, -renderW, 0, renderW, renderH);
        ctx.restore();
    } else {
        ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, renderW, renderH);
    }

    const rawImageData = ctx.getImageData(0, 0, renderW, renderH);
    const rawData = rawImageData.data;

    // --- Analysis ---
    let totalR=0, totalG=0, totalB=0;
    let cornerSignificantDiffs = 0, cornerPixelCount = 0;
    const sampleStride = 4;
    const cornerMarginX = Math.floor(renderW * 0.2);
    const cornerMarginY = Math.floor(renderH * 0.2);

    for (let i = 0; i < rawData.length; i += 4 * sampleStride) {
        const r = rawData[i], g = rawData[i+1], b = rawData[i+2];
        totalR += r; totalG += g; totalB += b;

        const pIndex = i/4;
        const x = pIndex % renderW;
        const y = Math.floor(pIndex / renderW);

        const isCorner = (x < cornerMarginX || x > renderW - cornerMarginX) && (y < cornerMarginY || y > renderH - cornerMarginY);
        
        if (isCorner && previousRawFrameData && previousRawFrameData.length === rawData.length) {
            cornerPixelCount++;
            const pr = previousRawFrameData[i], pg = previousRawFrameData[i+1], pb = previousRawFrameData[i+2];
            if (Math.abs(r-pr) + Math.abs(g-pg) + Math.abs(b-pb) > 50) {
                cornerSignificantDiffs++;
            }
        }
    }

    const cornerMotionRatio = cornerPixelCount > 0 ? (cornerSignificantDiffs / cornerPixelCount) : 0;
    const totalSamples = rawData.length / (4 * sampleStride);
    const avgR = totalR/totalSamples, avgG = totalG/totalSamples, avgB = totalB/totalSamples;
    const tempDiff = (avgR - avgB);
    state.currentLuma = (0.299*avgR + 0.587*avgG + 0.114*avgB);

    // --- Prepare Render ---
    let renderImageData;
    if (s.blur > 0) {
        ctx.filter = `blur(${s.blur}px)`;
        if (state.cameraFacing === 'user') {
            ctx.save();
            ctx.scale(-1, 1);
            ctx.drawImage(video, cropX, cropY, cropW, cropH, -renderW, 0, renderW, renderH);
            ctx.restore();
        } else {
            ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, renderW, renderH);
        }
        ctx.filter = 'none';
        renderImageData = ctx.getImageData(0, 0, renderW, renderH);
    } else {
        renderImageData = rawImageData;
    }
    const renderData = renderImageData.data;
    const currentRawFrameSnapshot = new Uint8ClampedArray(rawData);

    // 0 = Off. 100 = Step 128 (Extreme, 2 colors). 20 = Step 25 (Visible banding).
    const crush = s.colorDepth;
    const useBanding = crush > 0;
    const colorLUT = new Uint8Array(256);
    
    if (useBanding) {
        // Map 0-100 slider to 0-128 step size
        const step = (crush / 100) * 128; 
        
        for(let i=0; i<256; i++) {
            if (step < 1) {
                colorLUT[i] = i;
            } else {
                // Quantize to nearest step
                let val = Math.round(i / step) * step;
                colorLUT[i] = Math.max(0, Math.min(255, Math.round(val)));
            }
        }
    }

    // --- Effects ---
    if (cornerMotionRatio > s.motionThreshold) {
        jitterSustain = 4;
    }
    let jitterX = 0, jitterY = 0;
    if (jitterSustain > 0) {
        const maxJitter = s.jitterIntensity;
        const intensity = Math.min(maxJitter, Math.max(2, cornerMotionRatio * maxJitter * 2));
        jitterX = Math.floor((Math.random() - 0.5) * intensity);
        jitterY = Math.floor((Math.random() - 0.5) * intensity);
        jitterSustain--;
    }

    const hueShift = (tempDiff / 255) * s.hueShift;
    const sourcePixels = new Uint8ClampedArray(renderData);

    // Interlace
    if (s.interlace > 0 && previousRawFrameData && previousRawFrameData.length === rawData.length) {
        for (let y = 1; y < renderH; y+=2) {
            const offset = y * renderW * 4;
            for (let i = offset; i < offset + renderW*4; i++) {
                sourcePixels[i] = (sourcePixels[i] * (1-s.interlace)) + (previousRawFrameData[i] * s.interlace);
            }
        }
    }

    const hWaveScanlineOffsets = new Float32Array(renderH);
    if (s.hWave > 0) {
        state.waveTimer += 0.5; 
        
        for (let i = 0; i < renderH; i++) {
            // High frequency sine (Very thin bands)
            const w1 = Math.sin(i * 4.0 + state.waveTimer);
            
            // Reduced noise range for a cleaner "zipper" look
            const noise = (Math.random() - 0.5) * 0.5; 
            
            // Hard threshold for digital tracking tear
            const shape = (w1 + noise) > 0 ? 1 : -1;
            
            // CHANGED: Multiplied by 0.15. 
            // Previous version used raw 1.0, which shifted pixels way too far.
            // This ensures the distortion remains tight to the edge.
            hWaveScanlineOffsets[i] = shape * (s.hWave * 0.15);
        }
    }

    // Scanline & Tracking
    const scanlineFlicker = Math.random() * 0.08;
    const scanlineBase = 1 - (s.scanlineIntensity * 0.2);
    const scanlineMult = scanlineBase - (s.scanlineIntensity * scanlineFlicker);
    
    const artifactProbability = s.trackingNoise * 0.3;
    const hasTrackingArtifact = Math.random() < artifactProbability;
    const trackingY = hasTrackingArtifact ? Math.floor(Math.random() * (renderH - 4)) : -1;

    const doCurvature = Math.abs(s.curvature) > 0.01;
    const curv = s.curvature;
    const doSharpen = s.sharpen > 0;
    const sharpAmt = s.sharpen;

    // Helpers
    const getSafe = (arr, x, y) => {
        if (x < 0) x = 0; if (x >= renderW) x = renderW - 1;
        if (y < 0) y = 0; if (y >= renderH) y = renderH - 1;
        const idx = (y * renderW + x) * 4;
        return { r: arr[idx], g: arr[idx+1], b: arr[idx+2] };
    };
    
    // Update Vertical Roll State
    if (s.vertRoll > 0) {
        state.rollOffset = (state.rollOffset || 0) + (renderH * s.vertRoll * 0.1); 
        if (state.rollOffset > renderH) state.rollOffset -= renderH;
    } else {
        state.rollOffset = 0;
    }
    const rollY = Math.floor(state.rollOffset);

    // Pixel Loop
    for (let y = 0; y < renderH; y++) {
        // 1. V-Hold Roll: Wrap the Y coordinate
        let vRollSy = y - rollY;
        if (vRollSy < 0) vRollSy += renderH;

        // 2. Sync Bar: Create a dark band at the rolling seam
        const isSyncBar = s.vertRoll > 0 && vRollSy > renderH - (renderH * 0.05);

        const waveOffsetX = s.hWave > 0 ? hWaveScanlineOffsets[y] : 0;

        // 3. Tracking Artifacts (Calculated on the rolled Y)
        const isTrackingRow = hasTrackingArtifact && vRollSy >= trackingY && vRollSy < trackingY + 2;
        
        // 4. Curvature (Calculated on the rolled Y)
        const ny = doCurvature ? (vRollSy / renderH) * 2 - 1 : 0;

        for (let x = 0; x < renderW; x++) {
            let sx = x, sy = vRollSy;
            
            if (doCurvature) {
                const nx = (x / renderW) * 2 - 1;
                const r2 = nx*nx + ny*ny;
                const f = 1 + curv * r2;
                sx = (nx * f + 1) * 0.5 * renderW;
                sy = (ny * f + 1) * 0.5 * renderH;
            }
            sx += waveOffsetX; 
            sx += jitterX;
            sy += jitterY;

            // Coordinates
            const srcX = Math.floor(sx);
            const srcY = Math.floor(sy);
            
            let r=0, g=0, b=0;

            // Helper to safe-read pixels
            const getPx = (tx, ty, offset) => {
                if (tx >= 0 && tx < renderW && ty >= 0 && ty < renderH) {
                    return sourcePixels[(ty * renderW + tx) * 4 + offset];
                }
                return 0;
            };

            // 5. VHS Color Bleed Calculation
            // Smear Red and Blue to the left/right relative to Green
            let bleedR_X = sx;
            let bleedB_X = sx;
            
            if (s.colorBleed > 0 && !isSyncBar) {
                bleedR_X = sx - s.colorBleed;       // Red lags behind
                bleedB_X = sx - (s.colorBleed * 0.5); // Blue lags slightly
            }

            // --- PIXEL READ ---
            if (isSyncBar) {
                // Draw the rolling black bar
                r = g = b = 15; 
            } else if (doSharpen && !isSyncBar) {
                // Sharpen Logic (Applied primarily to Green/Luma)
                // We read Neighbors relative to the rolled Y (srcY)
                
                // Read Green (Detail channel) with sharpening
                // Note: Simplified sharpen for brevity in this complex loop
                const c = getPx(srcX, srcY, 1);
                const n = getPx(srcX, srcY-1, 1) + getPx(srcX, srcY+1, 1) + getPx(srcX-1, srcY, 1) + getPx(srcX+1, srcY, 1);
                g = c*(1+4*sharpAmt) - sharpAmt*n;

                // Read Red/Blue from Bleed coordinates (Unsharpened to enhance smear)
                r = getPx(Math.floor(bleedR_X), srcY, 0);
                b = getPx(Math.floor(bleedB_X), srcY, 2);
            } else {
                // Standard Read
                g = getPx(srcX, srcY, 1);
                r = getPx(Math.floor(bleedR_X), srcY, 0);
                b = getPx(Math.floor(bleedB_X), srcY, 2);
            }

            // 6. LENS FRINGE OVERRIDE
            // Applies chromatic aberration on top of the VHS bleed
            if (s.lensFringe > 0 && !isSyncBar) {
                const fringe = s.lensFringe;
                
                const rX = Math.floor(sx - fringe);
                const bX = Math.floor(sx + fringe);

                const rOff = getPx(rX, srcY, 0);
                const bOff = getPx(bX, srcY, 2);

                // Opacity: 0.6 (60% Fringe, 40% Original)
                const fOp = 0.6; 
                
                r = r * (1 - fOp) + rOff * fOp;
                b = b * (1 - fOp) + bOff * fOp;
            }

            // --- Post Processing ---

            // Color FX
            if (Math.abs(hueShift) > 0.01) {
                const rN = r/255, gN = g/255, bN = b/255;
                const cMax = Math.max(rN, gN, bN), cMin = Math.min(rN, gN, bN);
                const delta = cMax - cMin;
                let hVal=0, sVal=0, lVal=(cMax+cMin)/2;
                if (delta !== 0) {
                    sVal = lVal > 0.5 ? delta/(2-cMax-cMin) : delta/(cMax+cMin);
                    if (cMax===rN) hVal=(gN-bN)/delta + (gN<bN?6:0);
                    else if(cMax===gN) hVal=(bN-rN)/delta + 2;
                    else hVal=(rN-gN)/delta+4;
                    hVal/=6;
                }
                hVal += hueShift;
                if (hVal<0) hVal+=1; if(hVal>1) hVal-=1;
                if(sVal!==0) {
                    const q = lVal<0.5 ? lVal*(1+sVal) : lVal+sVal-lVal*sVal;
                    const p = 2*lVal-q;
                    const hue2rgb = (t) => {
                        if(t<0) t+=1; if(t>1) t-=1;
                        if(t<1/6) return p+(q-p)*6*t;
                        if(t<1/2) return q;
                        if(t<2/3) return p+(q-p)*(2/3-t)*6;
                        return p;
                    }
                    r = hue2rgb(hVal+1/3)*255; g = hue2rgb(hVal)*255; b = hue2rgb(hVal-1/3)*255;
                }
            }

            const gray = 0.299*r + 0.587*g + 0.114*b;
            r = gray + (r-gray)*s.saturation;
            g = gray + (g-gray)*s.saturation;
            b = gray + (b-gray)*s.saturation;

            r = (r-128)*s.contrast + 128;
            g = (g-128)*s.contrast + 128;
            b = (b-128)*s.contrast + 128;

            r *= s.brightness; g *= s.brightness; b *= s.brightness;

            // Flash Blowout
            if (state.flashActiveFrame) {
                r = r * 3 + 100;
                g = g * 3 + 100;
                b = b * 3 + 100;
            }

            // Bit Crush / Banding
            if (useBanding) {
                let ri = r < 0 ? 0 : (r > 255 ? 255 : r);
                let gi = g < 0 ? 0 : (g > 255 ? 255 : g);
                let bi = b < 0 ? 0 : (b > 255 ? 255 : b);
                
                r = colorLUT[Math.round(ri)];
                g = colorLUT[Math.round(gi)];
                b = colorLUT[Math.round(bi)];
            }

            // Vignette
            if (s.vignette > 0) {
                const dx = x - renderW/2;
                const dy = y - renderH/2;
                const maxRad = Math.sqrt((renderW/2)**2 + (renderH/2)**2); 
                const dist = Math.sqrt(dx*dx + dy*dy);
                
                let vig = 1 - (dist / maxRad) * s.vignette;
                vig = Math.max(0, vig); 
                
                r *= vig; g *= vig; b *= vig;
            }

            // Noise
            const noise = (Math.random()-0.5)*s.noise;
            r+=noise; g+=noise; b+=noise;

            // Scanlines
            if (s.scanlineIntensity > 0 && y%2===0) {
                r*=scanlineMult; g*=scanlineMult; b*=scanlineMult;
            }

            // Tracking Artifacts
            if (isTrackingRow) {
                r = Math.min(255, r+40);
                g = Math.min(255, g+40);
                b = Math.min(255, b+40);
                const trk = (Math.random()-0.5)*(50+(s.trackingNoise*50));
                r+=trk; g+=trk; b+=trk;
            }

            const dIdx = (y*renderW + x)*4;
            renderData[dIdx] = r;
            renderData[dIdx+1] = g;
            renderData[dIdx+2] = b;
        }
    }

    ctx.putImageData(renderImageData, 0, 0);
    previousRawFrameData = currentRawFrameSnapshot;

    // --- Bloom Pass ---
    if (s.bloom > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const blurAmt = Math.max(2, renderW * 0.05); 
        ctx.filter = `blur(${blurAmt}px) brightness(1.5) contrast(1.2)`;
        ctx.globalAlpha = s.bloom * 0.6; 
        ctx.drawImage(els.canvas, 0, 0, renderW, renderH);
        ctx.restore();
    }

    // --- Unique Lens Damage (Dust/Scratches) ---
    // Requires state.damageCanvas to be populated by generateDamageMap()
    if (state.damageCanvas && s.lensDamage > 0) {
        ctx.save();
        
        // CHANGED: 'source-over' allows both Dark Dust and White Static to show.
        // Previous 'multiply' would hide the white static lines.
        ctx.globalCompositeOperation = 'source-over'; 
        
        ctx.globalAlpha = s.lensDamage;
        
        // Jitter the damage map slightly (Film Gate/Tape Shake)
        const dmgJitterX = (Math.random() - 0.5) * 2;
        const dmgJitterY = (Math.random() - 0.5) * 2;
        
        ctx.drawImage(state.damageCanvas, dmgJitterX, dmgJitterY);
        ctx.restore();
    }

    // --- Date Stamp ---
    if (s.dateStamp === 'on') {
        const d = new Date();
        const year = d.getFullYear().toString().slice(-2);
        const month = d.getMonth() + 1;
        const day = d.getDate();
        const dateStr = `'${year} ${month} ${day}`;

        ctx.save();
        const fontSize = Math.max(12, Math.floor(renderH * 0.05));
        ctx.font = `${fontSize}px "VCR", monospace`; 
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'right';
        const padX = renderW * 0.05;
        const padY = renderH * 0.05;
        ctx.fillStyle = '#ffaa33'; 
        ctx.shadowColor = '#ff5500';
        ctx.shadowBlur = 4;
        ctx.fillText(dateStr, renderW - padX, renderH - padY);
        ctx.restore();
    }
}

// --- Interaction Logic ---

function startPress(e) {
    if (state.showSettings) return;
    if (e.cancelable) e.preventDefault();
    if (state.capturedImage || state.capturedVideo) return;
    
    // Resume audio context on user interaction if needed
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    // Stop propagation to avoid any global listeners
    e.stopPropagation();

    state.isLocked = false;
    updateUI();

    if (e.touches && e.touches.length > 0) {
        touchStartY = e.touches[0].clientY;
    }

    pressTimer = setTimeout(startRecording, LONG_PRESS_MS);
}

function handleTouchMove(e) {
    if (state.showSettings) return;

    // Check for pinch first (2 touches)
    if (e.touches && e.touches.length === 2) {
        handlePinchMove(e);
        return;
    }

    if (!state.isRecording || state.isLocked) return;
    
    // Lock drag logic (1 touch)
    if (e.touches && e.touches.length === 1) {
        const diff = touchStartY - e.touches[0].clientY;
        if (diff > 60) {
            state.isLocked = true;
            updateUI();
        }
    }
}

function endPress(e) {
    if (state.showSettings) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();

    // Cancel logic: if mouse leaves the button, or touch ends outside button
    let isCancel = false;

    if (e.type === 'mouseleave') {
        isCancel = true;
    } else if (e.type === 'touchend') {
        if (e.changedTouches && e.changedTouches.length > 0) {
            const touch = e.changedTouches[0];
            const elem = document.elementFromPoint(touch.clientX, touch.clientY);
            // If the element under the finger is not the button or inside it, it's a cancel
            if (!els.btnShutter.contains(elem)) {
                isCancel = true;
            }
        }
    }
    
    if (isCancel) {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
        if (state.isRecording && !state.isLocked) {
             stopRecording();
        }
        return;
    }

    if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
    }

    if (state.isRecording) {
        if (!state.isLocked) stopRecording();
    } else if (!state.capturedImage && !state.capturedVideo) {
        capturePhoto();
    }
}

async function capturePhoto() {
    if (!state.streamActive) return;

    let shouldFlash = state.flashMode === 'on';
    if (state.flashMode === 'auto' && state.currentLuma < 80) shouldFlash = true;

    if (shouldFlash) {
        // 1. Show UI Overlay instantly
        els.flashOverlay.classList.add('active'); // Instant opacity 1
        els.flashOverlay.classList.remove('hidden');

        // 2. Set render flag to blow out next frame
        state.flashActiveFrame = true;

        // 3. Wait a moment for frame to process and user to perceive flash
        await new Promise(r => setTimeout(r, 80));

        // 4. Capture
        const dataUrl = els.canvas.toDataURL('image/jpeg', 0.85);

        // 5. Reset flags
        state.flashActiveFrame = false;
        
        // 6. Fade out overlay
        els.flashOverlay.classList.remove('active'); // Revert to transition
        setTimeout(() => els.flashOverlay.classList.add('hidden'), 500); // Hide after fade

        processCapture(dataUrl);
    } else {
        const dataUrl = els.canvas.toDataURL('image/jpeg', 0.85);
        processCapture(dataUrl);
    }
}

async function processCapture(dataUrl) {    
    // Save backup to IDB
    try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        saveToBackup(blob, 'image');
    } catch(e) { console.error("Backup failed", e); }

    if (state.settings.autoSave === 'on') {
        saveMedia(dataUrl, 'image').then(() => {
            const prevText = els.counterText.textContent;
            els.counterText.textContent = "SAVED";
            setTimeout(() => {
                els.counterText.textContent = "";
            }, 1000);
        });
    } else {
        stopCamera(); 
        state.capturedImage = dataUrl;
        state.capturedVideo = null;
        updateUI();
    }
}

function startRecording() {
    if (state.isRecording) return;
    
    // Ensure audio context is running
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    state.isRecording = true;
    recordedChunks = [];
    updateUI();

    const canvasStream = els.canvas.captureStream(state.settings.fps);
    let finalStream = canvasStream;
    
    // Attach retro-processed audio if available, otherwise raw, otherwise none
    if (audioStreamProcessed) {
        // Use the processed destination stream tracks
        const audioTracks = audioStreamProcessed.getAudioTracks();
        if (audioTracks.length > 0) {
            finalStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
        }
    } else if (audioStream && audioStream.getAudioTracks().length > 0) {
        finalStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioStream.getAudioTracks()]);
    }

    try {
        mediaRecorder = new MediaRecorder(finalStream, {
            mimeType: 'video/webm;codecs=vp8,opus',
            videoBitsPerSecond: 2500000 // Increased bitrate
        });
    } catch (e) {
        try {
            mediaRecorder = new MediaRecorder(finalStream, { videoBitsPerSecond: 2500000 });
        } catch(e2) {
            state.isRecording = false;
            return;
        }
    }

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        
        // Backup
        saveToBackup(blob, 'video');
        
        const url = URL.createObjectURL(blob);
        
        if (state.settings.autoSave === 'on') {
            saveMedia(url, 'video').then(() => {
                 state.isRecording = false;
                 state.isLocked = false;
                 els.counterText.textContent = "SAVED";
                 setTimeout(() => {
                    els.counterText.textContent = "";
                    URL.revokeObjectURL(url);
                 }, 1000);
                 updateUI();
            });
        } else {
            stopCamera(); // Stop HW resources
            state.capturedVideo = url;
            state.capturedImage = null;
            state.isRecording = false;
            state.isLocked = false;
            updateUI();
        }
    };

    mediaRecorder.start(1000); // Request data every second
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
}

function retake() {
    if (state.capturedVideo) URL.revokeObjectURL(state.capturedVideo);
    
    // Clean up DOM elements if necessary (Video/Img src)
    els.resultImg.removeAttribute('src');
    els.resultVid.removeAttribute('src');
    
    state.capturedVideo = null;
    state.capturedImage = null;
    
    // Restart Hardware
    startCamera();
    
    updateUI();
}

async function download() {
    if (state.capturedImage) {
        await saveMedia(state.capturedImage, 'image');
        retake();
    } else if (state.capturedVideo) {
        await saveMedia(state.capturedVideo, 'video');
        retake();
    }
}

async function saveMedia(url, type) {
    const ext = type === 'image' ? 'jpg' : 'webm';
    const filename = `twosies_${Date.now()}.${ext}`;
    const mode = state.settings.saveMode || 'auto';

    const triggerDownload = () => {
         const link = document.createElement('a');
         link.download = filename;
         link.href = url;
         document.body.appendChild(link);
         link.click();
         document.body.removeChild(link);
    };

    try {
        // Force Download
        if (mode === 'download') {
            triggerDownload();
            return;
        }

        // Check availability for Share
        let canShare = false;
        try {
            if (navigator.canShare && navigator.share) {
                canShare = true;
            }
        } catch(e) { canShare = false; }

        if (!canShare) {
            // If we can't share, fallback to download immediately
            triggerDownload();
            return;
        }

        // Attempt Share
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], filename, { type: blob.type });

        if (navigator.canShare({ files: [file] })) {
             await navigator.share({
                 files: [file],
                 title: 'Twosies Capture', 
             });
             // If share promise resolves, it was successful
        } else {
             // Fallback if specific file content isn't shareable
             triggerDownload();
        }
    } catch (e) {
        // AbortError happens when user dismisses the share sheet
        if (e.name === 'AbortError') return;
        
        console.error('Save failed, trying fallback', e);
        triggerDownload();
    }
}

// --- UI Updates ---

function toggleSettings() {
    state.showSettings = !state.showSettings;
    if (state.showSettings) {
        // Refresh backup list when opening
        loadBackupsUI();
    }
    updateUI();
}

function updateUI() {
    // Flash
    els.flashIcon.classList.toggle('color-amber', state.flashMode === 'on');
    els.flashIcon.classList.toggle('color-zinc', state.flashMode !== 'on');
    els.flashOffSlash.classList.toggle('hidden', state.flashMode !== 'off');
    els.flashAutoText.classList.toggle('hidden', state.flashMode !== 'auto');

    // Settings
    els.settingsModal.classList.toggle('hidden', !state.showSettings);

    // Viewfinder overlays
    els.errorDisplay.classList.toggle('hidden', !state.hasError);
    if (state.hasError) els.errorMessage.textContent = state.hasError;

    els.resultPhoto.classList.toggle('hidden', !state.capturedImage);
    if (state.capturedImage) els.resultImg.src = state.capturedImage;

    els.resultVideo.classList.toggle('hidden', !state.capturedVideo);
    if (state.capturedVideo) els.resultVid.src = state.capturedVideo;

    els.canvasContainer.classList.toggle('hidden', !!(state.capturedImage || state.capturedVideo));

    els.recIndicator.classList.toggle('hidden', !state.isRecording);
    els.recStateText.textContent = state.isLocked ? 'LOCKED' : 'RECORD';

    // Show zoom indicator if zoomed or setting active
    const isZoomed = state.settings.zoom > 1.0;
    els.zoomIndicator.classList.toggle('hidden', state.showSettings || state.capturedImage || state.capturedVideo || !isZoomed);
    els.zoomIndicator.textContent = state.settings.zoom + 'x';

    // Controls
    if (state.capturedImage || state.capturedVideo) {
        els.controlsCapture.classList.add('hidden');
        els.controlsReview.classList.remove('hidden');
        els.btnFlip.parentElement.classList.add('hidden');
        els.counterText.textContent = 'MEMORY';
    } else {
        els.controlsCapture.classList.remove('hidden');
        els.controlsReview.classList.add('hidden');
        els.btnFlip.parentElement.classList.remove('hidden');
        if (state.isRecording) {
            els.counterText.textContent = state.isLocked ? 'LOCKED' : 'RECORD';
        } else if (els.counterText.textContent !== 'SAVED') {
            els.counterText.textContent = '';
        }
        
        // Shutter Buttons
        if (state.isLocked) {
            els.btnStopLock.classList.remove('hidden');
            els.containerShutter.classList.add('hidden');
        } else {
            els.btnStopLock.classList.add('hidden');
            els.containerShutter.classList.remove('hidden');
            
            els.hintLock.classList.toggle('hidden', !state.isRecording);
            els.btnShutter.classList.toggle('shutter-pressed', state.isRecording);
            els.btnShutter.classList.toggle('shutter-recording', state.isRecording);
        }
    }
    
    if (state.settings.aspectRatio && !state.capturedImage && !state.capturedVideo) {
        updateViewfinderAspect(state.settings.aspectRatio, state.settings.orientation);
    }
}

function updateViewfinderAspect(ratio, orientation) {
    const list = els.viewfinder.classList;
    // Remove old aspect classes
    list.remove('ratio-4-3', 'ratio-16-9', 'ratio-1-1', 'ratio-3-4', 'ratio-9-16');

    let isPortrait = orientation === 'auto' ? state.isDevicePortrait : orientation === 'portrait';

    if (ratio === '1:1') {
        list.add('ratio-1-1');
    } else if (ratio === '4:3') {
        list.add(isPortrait ? 'ratio-3-4' : 'ratio-4-3');
    } else if (ratio === '16:9') {
        list.add(isPortrait ? 'ratio-9-16' : 'ratio-16-9');
    }
}

// --- Settings Generation ---

const SETTING_DEFS = [
    { key: 'zoom', label: 'DIGITAL ZOOM', type: 'range', min: 1, max: 4, step: 0.1, unit: 'x' },
    { key: 'aspectRatio', label: 'ASPECT RATIO', type: 'select', options: ['4:3', '16:9', '1:1', '9:16'] },
    { key: 'orientation', label: 'ORIENTATION', type: 'select', options: ['auto', 'landscape', 'portrait'] },
    { key: 'dateStamp', label: 'DATE STAMP', type: 'select', options: ['off', 'on'] },
    { key: 'sourceResolution', label: 'MAXIMUM RESOLUTION', type: 'select', options: ['480p', '720p', '1080p'] },
    { key: 'quality', label: 'OUTPUT QUALITY', type: 'range', min: 80, max: 1080, step: 20, unit: 'px' },
    { key: 'fps', label: 'FRAME RATE', type: 'range', min: 1, max: 30, step: 1, unit: ' FPS' },
    { key: 'saturation', label: 'SATURATION', type: 'range', min: 0, max: 4, step: 0.1, unit: 'x' },
    { key: 'brightness', label: 'BRIGHTNESS', type: 'range', min: 0, max: 2, step: 0.1, unit: 'x' },
    { key: 'contrast', label: 'CONTRAST', type: 'range', min: 0, max: 5, step: 0.1, unit: 'x' },
    { key: 'noise', label: 'NOISE', type: 'range', min: 0, max: 100, step: 1, unit: '' },
    { key: 'bloom', label: 'LIGHT BLOOM', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'blur', label: 'SOFTNESS (BLUR)', type: 'range', min: 0, max: 3, step: 0.1, unit: 'px' },
    { key: 'sharpen', label: 'EDGE ENHANCE', type: 'range', min: 0, max: 3, step: 0.1, unit: 'x' },
    { key: 'hWave', label: 'H-WAVE DISTORTION', type: 'range', min: 0, max: 50, step: 1, unit: 'px' },
    { key: 'interlace', label: 'TEMPORAL INTERLACE', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'jitterIntensity', label: 'SHAKE INTENSITY', type: 'range', min: 0, max: 50, step: 1, unit: 'px' },
    { key: 'motionThreshold', label: 'MOTION SENSITIVITY', type: 'range', min: 0.01, max: 0.5, step: 0.01, unit: '' },
    { key: 'trackingNoise', label: 'TRACKING ARTIFACTS', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'scanlineIntensity', label: 'SCANLINES', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'vertRoll', label: 'V-HOLD ROLL', type: 'range', min: 0, max: 0.5, step: 0.01, unit: '' },
    { key: 'hueShift', label: 'COLOR TEMP SHIFT', type: 'range', min: 0, max: 2, step: 0.1, unit: 'x' },
    { key: 'colorDepth', label: 'BIT CRUSH', type: 'range', min: 0, max: 100, step: 2, unit: '%' },
    { key: 'colorBleed', label: 'VHS COLOR BLEED', type: 'range', min: 0, max: 50, step: 1, unit: 'px' },
    { key: 'lensFringe', label: 'LENS FRINGE', type: 'range', min: 0, max: 10, step: 0.5, unit: 'px' },
    { key: 'vignette', label: 'VIGNETTE', type: 'range', min: 0, max: 1.5, step: 0.1, unit: '' },
    { key: 'lensDamage', label: 'LENS DAMAGE', type: 'range', min: 0, max: 1.0, step: 0.1, unit: '' },
    { key: 'curvature', label: 'LENS CURVATURE', type: 'range', min: -0.5, max: 0.5, step: 0.05, unit: '' },
    { key: 'audioHiss', label: 'TAPE HISS', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'audioDistortion', label: 'AUDIO CRUNCH', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'autoSave', label: 'AUTO SAVE TO DEVICE', type: 'select', options: ['off', 'on'] },
    { key: 'saveMode', label: 'SAVE ACTION', type: 'select', options: ['auto', 'share', 'download'] },
];

function getUniqueSeed() {
    let name = localStorage.getItem('twosies_user_id');
    if (!name) {
        // Native JS Input
        name = prompt("INITIALIZING...\nENTER ANY WORD:") || "UNKNOWN";
        name = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
        localStorage.setItem('twosies_user_id', name);
    }
    
    // Generate Hash from Name + Screen + UserAgent
    const str = name + window.screen.width + window.screen.height + navigator.userAgent;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

// Seeded Random Number Generator
function seededRandom(seed) {
    var x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
}

function generateDamageMap(w, h) {
    if (!state.uniqueSeed) state.uniqueSeed = getUniqueSeed();
    
    const cvs = document.createElement('canvas');
    cvs.width = w;
    cvs.height = h;
    const ctx = cvs.getContext('2d');
    
    let seed = state.uniqueSeed;
    
    // 1. Sensor/Lens Dust (Dark, Fuzzy, Irregular)
    // Simulates dirt on the CCD sensor or lens, common in old camcorders
    const dustCount = 3 + Math.floor(seededRandom(seed++) * 5);
    
    for(let i=0; i<dustCount; i++) {
        const x = seededRandom(seed++) * w;
        const y = seededRandom(seed++) * h;
        const size = 20 + seededRandom(seed++) * 60; // Larger, softer blobs
        const opacity = 0.2 + seededRandom(seed++) * 0.3;
        
        // Create soft, organic smudge
        const grad = ctx.createRadialGradient(x, y, 0, x, y, size);
        grad.addColorStop(0, `rgba(20, 20, 20, ${opacity})`);
        grad.addColorStop(0.5, `rgba(40, 40, 40, ${opacity * 0.5})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        
        ctx.fillStyle = grad;
        ctx.beginPath();
        // Deform the circle slightly so it's not perfect
        ctx.ellipse(x, y, size, size * (0.8 + seededRandom(seed++)*0.4), seededRandom(seed++)*Math.PI, 0, Math.PI*2);
        ctx.fill();
    }

    // 2. Tape Dropouts (White, Horizontal Static)
    // Simulates magnetic tape signal loss
    const dropoutCount = 15 + Math.floor(seededRandom(seed++) * 20);
    
    for(let i=0; i<dropoutCount; i++) {
        const x = seededRandom(seed++) * w;
        const y = seededRandom(seed++) * h;
        const width = 10 + seededRandom(seed++) * 150;
        // VHS dropouts are thin horizontal lines
        const height = 1 + seededRandom(seed++) * 2; 
        const opacity = 0.1 + seededRandom(seed++) * 0.2;
        
        ctx.fillStyle = `rgba(220, 230, 255, ${opacity})`;
        ctx.fillRect(x, y, width, height);
    }
    
    return cvs;
}

function renderSettingsUI() {
    const container = els.settingsContainer;
    container.innerHTML = ''; // Clear

    // Groups could be implemented, but flat list is fine for now
    SETTING_DEFS.forEach(def => {
        const div = document.createElement('div');
        div.className = "setting-item";
        
        const labelRow = document.createElement('div');
        labelRow.className = "setting-label-row";
        
        const label = document.createElement('span');
        label.textContent = def.label;
        labelRow.appendChild(label);

        let input;
        
        if (def.type === 'range') {
            const valSpan = document.createElement('span');
            valSpan.textContent = state.settings[def.key] + (def.unit || '');
            labelRow.appendChild(valSpan);

            input = document.createElement('input');
            input.type = 'range';
            
            // Dynamic Max Logic for Quality
            let max = def.max;
            if (def.key === 'quality') {
                if (state.settings.sourceResolution === '1080p') max = 1080;
                else if (state.settings.sourceResolution === '720p') max = 720;
                else max = 480;
            }

            input.min = def.min; input.max = max; input.step = def.step;
            input.value = state.settings[def.key];
            input.oninput = (e) => {
                const val = parseFloat(e.target.value);
                state.settings[def.key] = val;
                valSpan.textContent = val + (def.unit || '');
                saveSettings();
                
                // Update specific subsystems in real time
                if (def.key.startsWith('audio')) {
                    updateAudioParams();
                } else {
                    updateUI();
                }
            };
        } else if (def.type === 'select') {
             input = document.createElement('select');
             input.className = "setting-select";
             def.options.forEach(opt => {
                 const o = document.createElement('option');
                 o.value = opt;
                 o.textContent = opt.toUpperCase();
                 input.appendChild(o);
             });
             input.value = state.settings[def.key];
             input.onchange = (e) => {
                 state.settings[def.key] = e.target.value;
                 if (def.key === 'sourceResolution') {
                     if (currentSourceRes !== state.settings.sourceResolution) {
                        currentSourceRes = state.settings.sourceResolution;
                        
                        // Handle Quality Max Cap
                        let newMax = 480;
                        if (currentSourceRes === '720p') newMax = 720;
                        if (currentSourceRes === '1080p') newMax = 1080;
                        
                        // Clamp if quality exceeds new resolution
                        if (state.settings.quality > newMax) {
                            state.settings.quality = newMax;
                        }

                        stopCamera();
                        setTimeout(startCamera, 100);
                        
                        // Re-render settings to update slider limits
                        renderSettingsUI();
                        saveSettings();
                        return;
                     }
                 }
                 saveSettings();
                 updateUI();
             }
             labelRow.appendChild(input);
        }

        div.appendChild(labelRow);
        if (def.type === 'range') div.appendChild(input);

        container.appendChild(div);
    });

    // Reset Button
    const resetBtn = document.createElement('button');
    resetBtn.className = "btn-reset";
    resetBtn.textContent = "RESET TO DEFAULTS";
    resetBtn.onclick = () => {
        state.settings = { ...DEFAULT_SETTINGS };
        saveSettings();
        renderSettingsUI();
        updateUI();
    };
    container.appendChild(resetBtn);
    
    // View Backups Button
    const backupsBtn = document.createElement('button');
    backupsBtn.className = "btn-view-backups";
    backupsBtn.textContent = "VIEW BACKUPS";
    backupsBtn.onclick = () => {
        if (els.backupsSection.classList.contains('hidden')) {
            loadBackupsUI();
        } else {
            els.backupsSection.classList.add('hidden');
        }
    };
    container.appendChild(backupsBtn);
}

// Start app
init();
