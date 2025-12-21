

// Default Settings
const DEFAULT_SETTINGS = {
    fps: 12,
    motionThreshold: 0.20,
    jitterIntensity: 10,
    hueShift: 0.4,
    saturation: 1.6,
    brightness: 0.9,
    contrast: 2.4,
    noise: 35,
    scanlineIntensity: 0.8,
    trackingNoise: 0.3,
    curvature: -0.1,
    blur: 0.5,
    sharpen: 1.0,
    bloom: 0.4,
    interlace: 0.2,
    quality: 240,
    zoom: 1.0,
    aspectRatio: '4:3',
    orientation: 'auto',
    sourceResolution: '480p',
    autoSave: 'off',
    saveMode: 'auto'
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
    flashActiveFrame: false // triggers whiteout in processFrame
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
    
    // Create thumbnail for backup list
    let thumb = '';
    if (type === 'image') {
        // Use the blob directly if image, or create a small version? 
        // For simplicity, we store the full blob.
        // In a real app, we might want a separate thumb store.
    }
    
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

function initStream(stream) {
    state.streamActive = true;
    
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
        audioStream = new MediaStream(audioTracks);
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
        els.video.srcObject.getVideoTracks().forEach(track => track.stop());
        if (stopAudio) {
            els.video.srcObject.getAudioTracks().forEach(track => track.stop());
        }
    }
    // We do NOT set streamActive = false here if we want seamless switch
    // But for full stop we would.
}

async function toggleCamera() {
    // Seamless switch logic
    state.cameraFacing = state.cameraFacing === 'environment' ? 'user' : 'environment';
    
    // Stop only video tracks, keep audio if recording?
    // Actually, getUserMedia will get us a new stream.
    // If we are recording, we are recording the Canvas Capture Stream.
    // The Canvas Capture Stream comes from the canvas.
    // The canvas is painted by processFrame.
    // processFrame reads from els.video.
    // So we just need to hot-swap els.video.srcObject without killing the MediaRecorder.

    const wasRecording = state.isRecording;

    // Stop current tracks
    if (els.video.srcObject) {
        els.video.srcObject.getTracks().forEach(t => t.stop());
    }

    // We don't call stopCamera() because we don't want to kill the loop or state vars
    
    try {
        const resolutionConstraints = getConstraintsForResolution(state.settings.sourceResolution);
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                ...resolutionConstraints,
                facingMode: { ideal: state.cameraFacing }
            },
            audio: true // Always get audio again to be safe
        });
        
        // Update audio stream reference for future recordings (or current? MediaRecorder is already bound)
        // Note: Changing audio source mid-MediaRecorder is hard. 
        // The MediaRecorder is likely bound to the stream created at startRecording.
        // If that stream was created from canvas + initial audio track, that audio track is now dead.
        // Complex constraint: Seamless audio switching in MediaRecorder is difficult without WebAudio API mixing.
        // For this retro app, losing audio momentarily or entirely on switch is acceptable 
        // as long as the video doesn't stop.
        
        els.video.srcObject = newStream;
        els.video.play();
        
        // Logic: The canvas loop continues running. It might read black frames for a moment.
        // This is acceptable glitching for a retro app.

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

    // Pixel Loop
    for (let y = 0; y < renderH; y++) {
        const isTrackingRow = hasTrackingArtifact && y >= trackingY && y < trackingY + 2;
        const ny = doCurvature ? (y / renderH) * 2 - 1 : 0;

        for (let x = 0; x < renderW; x++) {
            let sx = x, sy = y;
            if (doCurvature) {
                const nx = (x / renderW) * 2 - 1;
                const r2 = nx*nx + ny*ny;
                const f = 1 + curv * r2;
                sx = (nx * f + 1) * 0.5 * renderW;
                sy = (ny * f + 1) * 0.5 * renderH;
            }
            sx += jitterX;
            sy += jitterY;

            const srcX = Math.floor(sx);
            const srcY = Math.floor(sy);
            
            let r=0, g=0, b=0;

            if (doSharpen) {
                if (srcX >= 1 && srcX < renderW - 1 && srcY >= 1 && srcY < renderH - 1) {
                    const cIdx = (srcY * renderW + srcX) * 4;
                    const tIdx = ((srcY-1) * renderW + srcX) * 4;
                    const bIdx = ((srcY+1) * renderW + srcX) * 4;
                    const lIdx = (srcY * renderW + srcX-1) * 4;
                    const rIdx = (srcY * renderW + srcX+1) * 4;

                    const cr = sourcePixels[cIdx], cg = sourcePixels[cIdx+1], cb = sourcePixels[cIdx+2];
                    const tr = sourcePixels[tIdx], tg = sourcePixels[tIdx+1], tb = sourcePixels[tIdx+2];
                    const br = sourcePixels[bIdx], bg = sourcePixels[bIdx+1], bb = sourcePixels[bIdx+2];
                    const lr = sourcePixels[lIdx], lg = sourcePixels[lIdx+1], lb = sourcePixels[lIdx+2];
                    const rr = sourcePixels[rIdx], rg = sourcePixels[rIdx+1], rb = sourcePixels[rIdx+2];

                    r = cr*(1+4*sharpAmt) - sharpAmt*(tr+br+lr+rr);
                    g = cg*(1+4*sharpAmt) - sharpAmt*(tg+bg+lg+rg);
                    b = cb*(1+4*sharpAmt) - sharpAmt*(tb+bb+lb+rb);
                } else {
                    const c = getSafe(sourcePixels, srcX, srcY);
                    const t = getSafe(sourcePixels, srcX, srcY-1);
                    const bt = getSafe(sourcePixels, srcX, srcY+1);
                    const l = getSafe(sourcePixels, srcX-1, srcY);
                    const rt = getSafe(sourcePixels, srcX+1, srcY);
                    r = c.r*(1+4*sharpAmt) - sharpAmt*(t.r+bt.r+l.r+rt.r);
                    g = c.g*(1+4*sharpAmt) - sharpAmt*(t.g+bt.g+l.g+rt.g);
                    b = c.b*(1+4*sharpAmt) - sharpAmt*(t.b+bt.b+l.b+rt.b);
                }
            } else {
                if (srcX >= 0 && srcX < renderW && srcY >= 0 && srcY < renderH) {
                    const idx = (srcY * renderW + srcX) * 4;
                    r = sourcePixels[idx]; g = sourcePixels[idx+1]; b = sourcePixels[idx+2];
                }
            }

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

            // Flash Blowout - If flash active frame, override processing
            if (state.flashActiveFrame) {
                // Extreme blowout
                r = r * 3 + 100;
                g = g * 3 + 100;
                b = b * 3 + 100;
            }

            const noise = (Math.random()-0.5)*s.noise;
            r+=noise; g+=noise; b+=noise;

            if (s.scanlineIntensity > 0 && y%2===0) {
                r*=scanlineMult; g*=scanlineMult; b*=scanlineMult;
            }

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
        // Blur relative to resolution to keep look consistent
        const blurAmt = Math.max(2, renderW * 0.05); 
        ctx.filter = `blur(${blurAmt}px) brightness(1.5) contrast(1.2)`;
        ctx.globalAlpha = s.bloom * 0.6; 
        
        // Draw the video frame over the retro rendering
        // Note: We use the raw video so the bloom is "cleaner", mimicking light leak
        if (state.cameraFacing === 'user') {
            ctx.scale(-1, 1);
            ctx.drawImage(video, cropX, cropY, cropW, cropH, -renderW, 0, renderW, renderH);
        } else {
            ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, renderW, renderH);
        }
        ctx.restore();
    }
}

// --- Interaction Logic ---

function startPress(e) {
    if (state.showSettings) return;
    if (e.cancelable) e.preventDefault();
    if (state.capturedImage || state.capturedVideo) return;
    
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
                els.counterText.textContent = "RDY";
            }, 1000);
        });
    } else {
        state.capturedImage = dataUrl;
        state.capturedVideo = null;
        updateUI();
    }
}

function startRecording() {
    if (state.isRecording) return;
    state.isRecording = true;
    recordedChunks = [];
    updateUI();

    const canvasStream = els.canvas.captureStream(state.settings.fps);
    let finalStream = canvasStream;
    
    // We try to attach audio. 
    if (audioStream && audioStream.getAudioTracks().length > 0) {
        // We clone the track so we don't interfere with main stream if we were using it elsewhere
        // But here we just use the raw track.
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
                    els.counterText.textContent = "RDY";
                    URL.revokeObjectURL(url);
                 }, 1000);
                 updateUI();
            });
        } else {
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
    state.capturedVideo = null;
    state.capturedImage = null;
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
    els.recStateText.textContent = state.isLocked ? 'LOCKED' : 'REC';

    // Show zoom indicator if zoomed or setting active
    const isZoomed = state.settings.zoom > 1.0;
    els.zoomIndicator.classList.toggle('hidden', state.showSettings || state.capturedImage || state.capturedVideo || !isZoomed);
    els.zoomIndicator.textContent = state.settings.zoom + 'x';

    // Controls
    if (state.capturedImage || state.capturedVideo) {
        els.controlsCapture.classList.add('hidden');
        els.controlsReview.classList.remove('hidden');
        els.btnFlip.parentElement.classList.add('hidden');
        els.counterText.textContent = 'MEM';
    } else {
        els.controlsCapture.classList.remove('hidden');
        els.controlsReview.classList.add('hidden');
        els.btnFlip.parentElement.classList.remove('hidden');
        if (state.isRecording) {
            els.counterText.textContent = state.isLocked ? 'LCK' : 'REC';
        } else if (els.counterText.textContent !== 'SAVED') {
            els.counterText.textContent = 'RDY';
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
    { key: 'autoSave', label: 'AUTO SAVE TO DEVICE', type: 'select', options: ['off', 'on'] },
    { key: 'saveMode', label: 'SAVE ACTION', type: 'select', options: ['auto', 'share', 'download'] },
    { key: 'zoom', label: 'DIGITAL ZOOM', type: 'range', min: 1, max: 4, step: 0.1, unit: 'x' },
    { key: 'aspectRatio', label: 'ASPECT RATIO', type: 'select', options: ['4:3', '16:9', '1:1', '9:16'] },
    { key: 'orientation', label: 'ORIENTATION', type: 'select', options: ['auto', 'landscape', 'portrait'] },
    { key: 'sourceResolution', label: 'CAMERA QUALITY', type: 'select', options: ['480p', '720p', '1080p'] },
    { key: 'quality', label: 'EFFECT RESOLUTION', type: 'range', min: 80, max: 480, step: 20, unit: 'px' },
    { key: 'fps', label: 'FRAME RATE', type: 'range', min: 1, max: 30, step: 1, unit: ' FPS' },
    { key: 'curvature', label: 'LENS CURVATURE', type: 'range', min: -0.5, max: 0.5, step: 0.05, unit: '' },
    { key: 'blur', label: 'SOFTNESS (BLUR)', type: 'range', min: 0, max: 3, step: 0.1, unit: 'px' },
    { key: 'sharpen', label: 'EDGE ENHANCE', type: 'range', min: 0, max: 3, step: 0.1, unit: 'x' },
    { key: 'bloom', label: 'LIGHT BLOOM', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'interlace', label: 'TEMPORAL INTERLACE', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'jitterIntensity', label: 'SHAKE INTENSITY', type: 'range', min: 0, max: 50, step: 1, unit: 'px' },
    { key: 'trackingNoise', label: 'TRACKING ARTIFACTS', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'scanlineIntensity', label: 'SCANLINES', type: 'range', min: 0, max: 1, step: 0.1, unit: '' },
    { key: 'motionThreshold', label: 'MOTION SENSITIVITY', type: 'range', min: 0.01, max: 0.5, step: 0.01, unit: '' },
    { key: 'hueShift', label: 'COLOR TEMP SHIFT', type: 'range', min: 0, max: 2, step: 0.1, unit: 'x' },
    { key: 'saturation', label: 'SATURATION', type: 'range', min: 0, max: 4, step: 0.1, unit: 'x' },
    { key: 'brightness', label: 'BRIGHTNESS', type: 'range', min: 0, max: 2, step: 0.1, unit: 'x' },
    { key: 'contrast', label: 'CONTRAST', type: 'range', min: 0, max: 5, step: 0.1, unit: 'x' },
    { key: 'noise', label: 'NOISE', type: 'range', min: 0, max: 100, step: 1, unit: '' }
];

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
            input.min = def.min; input.max = def.max; input.step = def.step;
            input.value = state.settings[def.key];
            input.oninput = (e) => {
                const val = parseFloat(e.target.value);
                state.settings[def.key] = val;
                valSpan.textContent = val + (def.unit || '');
                saveSettings();
                updateUI();
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
                        stopCamera();
                        setTimeout(startCamera, 100);
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
    
