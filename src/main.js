import { Text, Mesh, Buffer, BufferUsage, Geometry, Shader } from "pixi.js";
import { app, initEngine } from "./engine.js";
import Timer from "./timer.js";

// --- SHADER ---
const vertexShader = `
    attribute vec2 aPosition;
    attribute vec2 aInstancePos;
    attribute float aInstanceRadius;
    attribute float aInstanceTemp;

    uniform mat3 uProjectionMatrix;
    uniform mat3 uWorldTransformMatrix;

    varying vec2 vLocalCoord;
    varying float vTemp;
    varying float vRadius; // <--- NEU: Wir senden den Radius an den Fragment Shader

    void main() {
        vLocalCoord = aPosition;
        vTemp = aInstanceTemp;
        vRadius = aInstanceRadius; // <--- NEU: Wert zuweisen

        vec2 finalPos = (aPosition * aInstanceRadius) + aInstancePos;
        gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * vec3(finalPos, 1.0)).xy, 0.0, 1.0);
    }
`;

const fragmentShader = `
    varying vec2 vLocalCoord;
    varying float vTemp;
    varying float vRadius; // <--- NEU: Radius empfangen

    void main() {
        float dist = length(vLocalCoord);
        
        // Exakt 1.0 Pixel auf dem Monitor (1.0 / vRadius ist genau 1 Pixel)
        float edgeWidth = 0.9 / vRadius; 
        
        // Pixel-perfektes Anti-Aliasing, unabhängig vom Zoom oder der Größe!
        float alpha = 1.0 - smoothstep(1.0 - edgeWidth, 1.0, dist);
        
        if(alpha < 0.001) discard;

        vec3 hotColor = vec3(1.0, 0.3, 0.1);
        vec3 coldColor = vec3(0.0, 1.0, 0.8);

        float tFactor = clamp(vTemp / 300.0, 0.0, 1.0);
        vec3 color = mix(coldColor, hotColor, tFactor);

        gl_FragColor = vec4(color * alpha, alpha); 
    }
`;

// --- DAS SYSTEM ---
class ParticleSystem {
  constructor(width, height, maxParticles, cellWidth) {
    this.max   = maxParticles;
    this.cellWidth = cellWidth;
    this.count = 0;
    
    // --- 1. SPEICHERBEDARF BERECHNEN ---
    const bytesPerArray = maxParticles * 4;
    const physicsBytes  = bytesPerArray * 8; // x, y, vx, vy, r, mass, invMass, temp

    // Grid-Dimensionen berechnen
    this.COLS = Math.floor(width / cellWidth) + 1;
    this.ROWS = Math.floor(height / cellWidth) + 1;
    const totalCells = this.COLS * this.ROWS;

    // Grid-Strukturen (32-Bit Integer)
    const countBytes  = totalCells * 4;         // cellCount
    const startBytes  = (totalCells + 1) * 4;   // cellStart
    const indexBytes  = maxParticles * 4;       // particleIndex
    const tempBytes   = totalCells * 4;         // tempCount

    // NEU: Render-Buffer für SIMD-Interleaving (x,y pro Partikel = 8 Bytes)
    const renderBufferBytes = maxParticles * 8; 

    // Gesamten Speicherbedarf summieren
    const totalBytesNeeded = physicsBytes + countBytes + startBytes + indexBytes + tempBytes + renderBufferBytes;
    
    // Speicher anfordern
    const fixedPages = 2560; 
    this.wasmMemory = new WebAssembly.Memory({ 
        initial: fixedPages, 
        maximum: fixedPages, // Bei Shared Memory muss das identisch sein
        shared: true 
    });
    const buffer    = this.wasmMemory.buffer;

    // --- 2. POINTER ZUWEISEN (Lineares Layout) ---
    let byteOffset = 0;

    // Physikalische Eigenschaften
    this.x       = new Float32Array(buffer, byteOffset, maxParticles); byteOffset += bytesPerArray;
    this.y       = new Float32Array(buffer, byteOffset, maxParticles); byteOffset += bytesPerArray;
    this.vx      = new Float32Array(buffer, byteOffset, maxParticles); byteOffset += bytesPerArray;
    this.vy      = new Float32Array(buffer, byteOffset, maxParticles); byteOffset += bytesPerArray;
    this.r       = new Float32Array(buffer, byteOffset, maxParticles); byteOffset += bytesPerArray;
    this.mass    = new Float32Array(buffer, byteOffset, maxParticles); byteOffset += bytesPerArray;
    this.invMass = new Float32Array(buffer, byteOffset, maxParticles); byteOffset += bytesPerArray;
    this.temp    = new Float32Array(buffer, byteOffset, maxParticles); byteOffset += bytesPerArray;

    // Grid Pointer
    const ptr_cellCount     = byteOffset; byteOffset += countBytes;
    const ptr_cellStart     = byteOffset; byteOffset += startBytes;
    const ptr_particleIndex = byteOffset; byteOffset += indexBytes;
    const ptr_tempCount     = byteOffset; byteOffset += tempBytes;

    // Render-Buffer Pointer (für den ReferenceError-Fix)
    const ptr_renderBuffer  = byteOffset; byteOffset += renderBufferBytes;

    // --- 3. ZERO-COPY MAPPING ---
    // Wir mappen die JavaScript-Sicht direkt auf den WASM-Render-Buffer
    this.instancePosBuffer = new Float32Array(buffer, ptr_renderBuffer, maxParticles * 2);

    // --- 4. WASM LADEN & INITIALISIEREN ---
    this.wasmReady = false; 
    const importObject = {
        env: {
            memory: this.wasmMemory,
            abort: (msg, file, line) => console.error(`Wasm Error at ${line}`)
        }
    };

    const wasmPath = import.meta.env.BASE_URL + 'physics.wasm';
    this.wasmPromise = WebAssembly.instantiateStreaming(fetch(wasmPath), importObject)
        .then(result => {
            this.wasmExports = result.instance.exports;
            
            // Pointer für Physik (x=0, y=1*bPA, ... invMass=6*bPA, temp=7*bPA)
            this.wasmExports.initPointers(
                0, bytesPerArray, bytesPerArray*2, bytesPerArray*3, 
                bytesPerArray*4, bytesPerArray*6, bytesPerArray*7
            );
            
            // Pointer für Grid
            this.wasmExports.initGrid(
                ptr_cellCount, ptr_cellStart, ptr_particleIndex, ptr_tempCount, 
                this.COLS, this.ROWS, cellWidth
            );

            // Pointer für Render-Shuffle
            this.wasmExports.initRenderPointer(ptr_renderBuffer);

            this.wasmReady = true;
            console.log("WASM SYSTEM OPERATIONAL! 🚀");
        });

    // --- 5. PIXI RENDERING SETUP ---
    // Wichtig: Wir nutzen hier die 'this.instancePosBuffer' View von oben!
    this.posBuffer  = new Buffer({ data: this.instancePosBuffer, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.radBuffer  = new Buffer({ data: this.r,                 usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.tempBuffer = new Buffer({ data: this.temp,              usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });

    this.geometry = new Geometry({
        attributes: {
            aPosition:       { buffer: new Buffer({ data: new Float32Array([-1,-1, 1,-1, 1,1, -1,1]) }), format: 'float32x2' },
            aInstancePos:    { buffer: this.posBuffer,  format: 'float32x2', instance: true },
            aInstanceRadius: { buffer: this.radBuffer,  format: 'float32',   instance: true },
            aInstanceTemp:   { buffer: this.tempBuffer, format: 'float32',   instance: true },
        },
        indexBuffer: new Buffer({
            data: new Uint16Array([0,1,2,0,2,3]),
            usage: BufferUsage.INDEX
        }),
    });

    this.geometry.instanceCount = 0;
    const shader = Shader.from({ gl: { vertex: vertexShader, fragment: fragmentShader } });
    this.mesh = new Mesh({ geometry: this.geometry, shader });
    this.mesh.cullable = false;
    app.stage.addChild(this.mesh);
  }

  // --- NEUE METHODE: WORKER SPAWNEN ---
  async initThreads() {
    this.workerCount = Math.max(1, navigator.hardwareConcurrency - 1);
    this.workers = [];

    const wasmPath = import.meta.env.BASE_URL + 'physics.wasm';
    const response = await fetch(wasmPath);
    const wasmModule = await WebAssembly.compile(await response.arrayBuffer());
    const bPA = this.max * 4; // bytesPerArray

    const workerPromises = [];

    for (let i = 0; i < this.workerCount; i++) {
        const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

        const p = new Promise(resolve => {
            worker.onmessage = (e) => {
                if (e.data.type === 'ready') resolve();
            };
        });

        worker.postMessage({
            type: 'init',
            module: wasmModule,
            memory: this.wasmMemory,
            id: i,
            // Dieselben Werte wie im Main-Thread initPointers-Aufruf
            pointers: {
                x:       0,
                y:       bPA,
                vx:      bPA * 2,
                vy:      bPA * 3,
                r:       bPA * 4,
                invMass: bPA * 6,
                temp:    bPA * 7,
            },
            // Dieselben Werte wie im Main-Thread initGrid-Aufruf
            grid: {
                cellCount:     bPA * 8,
                cellStart:     bPA * 8 + this.COLS * this.ROWS * 4,
                particleIndex: bPA * 8 + this.COLS * this.ROWS * 4 + (this.COLS * this.ROWS + 1) * 4,
                tempCount:     bPA * 8 + this.COLS * this.ROWS * 4 + (this.COLS * this.ROWS + 1) * 4 + this.max * 4,
                cols:          this.COLS,
                rows:          this.ROWS,
                cellSize:      this.cellWidth,
            }
        });

        this.workers.push(worker);
        workerPromises.push(p);
    }

    await Promise.all(workerPromises);
    console.log(`${this.workerCount} WORKER THREADS BEREIT!`);
  }

  /**
 * Teilt eine Aufgabe (Task) lückenlos auf alle Worker und den Main-Thread auf.
 * @param {string} taskType - Typ der Aufgabe (z.B. 'work_movement', 'grid_p1')
 * @param {object} params - Zusätzliche Parameter (dt, width, phase etc.)
 */
  async runParallel(taskType, params) {
    if (!this.wasmReady || this.workers.length === 0) return;

    // Je nach Task-Typ teilen wir entweder Partikel oder Grid-Zeilen auf
    const isGridTask = taskType === 'work_collision';
    const total = isGridTask ? this.ROWS : this.count;
    
    // Berechne die Stückgröße für jeden Beteiligten (Worker + Main Thread)
    const chunkSize = Math.ceil(total / (this.workerCount + 1));
    const promises = [];

    for (let i = 0; i < this.workerCount; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, total);
        
        // Verhindere das Verschicken von leeren Aufgaben
        if (start >= end) continue;

        promises.push(new Promise(resolve => {
            const handler = (e) => {
                if (e.data.type === 'done') {
                    this.workers[i].removeEventListener('message', handler);
                    resolve();
                }
            };
            this.workers[i].addEventListener('message', handler);
            this.workers[i].postMessage({
                type: taskType,
                start: start, // Lückenlose Übergabe des exakten Index
                end: end,
                params: params
            });
        }));
    }

    // Der Main-Thread übernimmt das letzte verbleibende Stück
    const mainStart = this.workerCount * chunkSize;
    if (mainStart < total) {
        switch (taskType) {
            case 'work_movement':
                this.wasmExports.updateMovementParallel(mainStart, total, params.dt, params.width, params.height);
                break;
            case 'work_collision':
                this.wasmExports.checkCollisionsParallel(mainStart, total, params.phase, params.maxR, params.restitution, params.heatRate);
                break;
            case 'grid_p1':
                this.wasmExports.gridPhase1Parallel(mainStart, total);
                break;
            case 'grid_p3':
                this.wasmExports.gridPhase3Parallel(mainStart, total);
                break;
            case 'update_render':
                this.wasmExports.updateRenderBuffer(total); // Render-Buffer meist komplett auf Main
                break;
        }
    }

    await Promise.all(promises);
  }

  spawn(x, y, vx, vy, r, temp) {
    if (this.count >= this.max) return -1;
    let id = this.count++;

    this.x[id]       = x;
    this.y[id]       = y;
    this.vx[id]      = vx;
    this.vy[id]      = vy;
    this.r[id]       = r;
    this.mass[id]    = r * r;
    this.invMass[id] = 1.0 / this.mass[id];
    this.temp[id]    = temp;

    this.geometry.instanceCount = this.count;
    return id;
  }

  updateMovement(dt, width, height) {
    if (this.wasmReady)
      this.wasmExports.updateMovement(this.count, dt, width, height);
  }

  rebuildGrid() {
    if (this.wasmReady)
      this.wasmExports.rebuildGrid(this.count);
  }

  // In ParticleSystem Klasse
  async rebuildGridParallel() {
    // 0. Counter leeren (WASM)
    this.wasmExports.clearGridCounters();

    // 1. Phase 1 Parallel (Counting)
    await this.runParallel('grid_p1', {});

    // 2. Phase 2 Seriell (Prefix Sum auf Main Thread)
    this.wasmExports.gridPrefixSum();

    // 3. Phase 3 Parallel (Sorting/Packing)
    await this.runParallel('grid_p3', {});
  }

  checkCollisions() {
    const heatTransferRate = 0.01;
    const restitution    = 0.99;

    if (this.wasmReady)
      this.wasmExports.checkCollisions(this.count, restitution, heatTransferRate);
  }

  // In ParticleSystem Klasse
  async checkCollisionsParallel() {
    const params = { restitution: 0.99, heatRate: 0.01 };
    
    // Wir führen 4 Phasen nacheinander aus. 
    // Innerhalb einer Phase arbeiten alle Worker gleichzeitig auf sicheren Zellen.
    for (let phase = 0; phase < 4; phase++) {
        await this.runParallel('work_collision_phase', { ...params, phase });
    }
  }

  async checkCollisionsCheckerboard() {
    const restitution = 0.99;
    const heatRate = 0.01;
    const maxR = this.cellWidth * 0.5;
    
    // Jetzt 9 Phasen (0 bis 8) nacheinander abarbeiten
    for (let phase = 0; phase < 9; phase++) {
        const rowChunk = Math.ceil(this.ROWS / (this.workerCount + 1));
        const promises = [];

        for (let i = 0; i < this.workerCount; i++) {
            const startRow = i * rowChunk;
            const endRow = Math.min(startRow + rowChunk, this.ROWS);
            
            promises.push(new Promise(resolve => {
                const handler = (e) => {
                    if (e.data.type === 'done') {
                        this.workers[i].removeEventListener('message', handler);
                        resolve();
                    }
                };
                this.workers[i].addEventListener('message', handler);
                this.workers[i].postMessage({
                    type: 'work_collision',
                    start: startRow,
                    end: endRow,
                    params: { phase, maxR, restitution, heatRate }
                });
            }));
        }

        const mainStartRow = this.workerCount * rowChunk;
        if (mainStartRow < this.ROWS) {
            this.wasmExports.checkCollisionsParallel(mainStartRow, this.ROWS, phase, maxR, restitution, heatRate);
        }

        await Promise.all(promises);
    }
  }

  draw() {
    if (!this.wasmReady) return;

    // 1. WASM ordnet die Bytes im RAM neu (SIMD Turbo)
    this.wasmExports.updateRenderBuffer(this.count);

    // 2. PixiJS schickt den RAM-Bereich zur GPU
    this.posBuffer.update(); 
    this.radBuffer.update();
    this.tempBuffer.update();
  }
}

async function startEngine() {
  await initEngine();

  let width  = app.screen.width;
  let height = app.screen.height;

  let minR = 1.0;
  let maxR = 1.0;

  let allTimer       = new Timer().startCollection();
  let movementTimer  = new Timer().startCollection();
  let gridBuildTimer = new Timer().startCollection();
  let collisionTimer = new Timer().startCollection();
  let drawTimer      = new Timer().startCollection();
  let restTimer      = new Timer().startCollection();
  let amount = 500000;

  const system = new ParticleSystem(width, height, amount, maxR * 2);
  await system.initThreads();

  for (let i = 0; i < amount; i++) {
    let r  = minR + Math.random() * (maxR - minR);
    let x  = r + Math.random() * (width  - r * 2);
    let y  = r + Math.random() * (height - r * 2);
    let vx = -100 + Math.random() * 200;
    let vy = -100 + Math.random() * 200;
    let t  = Math.random() > 0.95 ? 300 : 20;
    system.spawn(x, y, vx, vy, r, t);
  }

  const infoText = new Text({
    text: '',
    style: {
      fontFamily: 'Arial',
      fontSize: 24,
      fill: 0xffffff,
      fontWeight: 'bold',
      dropShadow: true,
      dropShadowColor: '#000000',
      dropShadowBlur: 4,
      dropShadowDistance: 2,
    }
  });
  infoText.x = 20;
  infoText.y = 20;
  app.stage.addChild(infoText);

  console.log(navigator.hardwareConcurrency);

  let isProcessing = false;

  app.ticker.add(async (ticker) => {
    if (isProcessing) return; // Wenn der letzte Frame noch rechnet: Überspringen!
    isProcessing = true;

    restTimer.stop();

    allTimer.stop();
    allTimer.start();

    movementTimer.start();
    await system.runParallel('work_movement', { 
        dt: ticker.deltaMS * 0.001, 
        width: width, 
        height: height 
    });
    movementTimer.stop();

    gridBuildTimer.start();
    await system.rebuildGridParallel();
    //system.rebuildGrid();
    gridBuildTimer.stop();

    collisionTimer.start();
    // Wir rufen eine neue Methode auf, die die 4 Phasen steuert
    await system.checkCollisionsCheckerboard(); 
    collisionTimer.stop();

    drawTimer.start();
    system.draw();
    drawTimer.stop();

    restTimer.start();

    const allMinMS = allTimer.getMinMillis().toFixed(2);
    const allAvgMS = allTimer.getAvgMillis().toFixed(2);
    const allMaxMS = allTimer.getMaxMillis().toFixed(2);
    const minFPS = Math.round(1000 / (allMaxMS > 0 ? allMaxMS : 0.01));
    const avgFPS = Math.round(1000 / (allAvgMS > 0 ? allAvgMS : 0.01));
    const maxFPS = Math.round(1000 / (allMinMS > 0 ? allMinMS : 0.01));

    const movementMS   = movementTimer.getAvgMillis().toFixed(2);
    const gridBuildMS   = gridBuildTimer.getAvgMillis().toFixed(2);
    const collisionMS   = collisionTimer.getAvgMillis().toFixed(2);
    const drawMS     = drawTimer.getAvgMillis().toFixed(2);
    const restMS     = restTimer.getAvgMillis().toFixed(2);

    infoText.text = `
    Partikel: ${amount}
    FPS max: ${maxFPS}
    FPS avg: ${avgFPS}
    FPS min: ${minFPS}
    Movement: ${movementMS}
    Build grid: ${gridBuildMS}
    Collision: ${collisionMS}
    Draw: ${drawMS}
    Rest: ${restMS}
    `;

    isProcessing = false;
  });
}

startEngine();