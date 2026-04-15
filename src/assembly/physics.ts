// ==========================================
// --- SPEICHER-POINTER (Adressen im RAM) ---
// ==========================================
let ptr_x: usize;
let ptr_y: usize;
let ptr_vx: usize;
let ptr_vy: usize;
let ptr_r: usize;
let ptr_invMass: usize;
let ptr_temp: usize;

let ptr_cellCount: usize;
let ptr_cellStart: usize;
let ptr_particleIndex: usize;
let ptr_tempCount: usize;

let gridCols: i32;
let gridRows: i32;
let invCellSize: f32;

// ==========================================
// --- INITIALISIERUNG ---
// ==========================================

export function initPointers(x: usize, y: usize, vx: usize, vy: usize, r: usize, invMass: usize, temp: usize): void {
    ptr_x = x;
    ptr_y = y;
    ptr_vx = vx;
    ptr_vy = vy;
    ptr_r = r;
    ptr_invMass = invMass;
    ptr_temp = temp;
}

export function initGrid(countPtr: usize, startPtr: usize, indexPtr: usize, tempPtr: usize, cols: i32, rows: i32, cellSize: f32): void {
    ptr_cellCount = countPtr;
    ptr_cellStart = startPtr;
    ptr_particleIndex = indexPtr;
    ptr_tempCount = tempPtr;
    gridCols = cols;
    gridRows = rows;
    invCellSize = f32(1.0) / cellSize;
}

// ==========================================
// --- LOOP A: BEWEGUNG & WÄNDE (SIMD) ---
// ==========================================

@inline
function applySafeBranchlessWalls(id: i32, width: f32, height: f32): void {
    let off = id * 4;
    let px = load<f32>(ptr_x + off);
    let py = load<f32>(ptr_y + off);
    let pvx = load<f32>(ptr_vx + off);
    let pvy = load<f32>(ptr_vy + off);
    let pr = load<f32>(ptr_r + off);

    let limX = width - pr;
    let limY = height - pr;

    // --- Position Clamping ---
    // select<T>(if_true, if_false, condition)
    let new_px = select<f32>(pr, px, px < pr);
    new_px = select<f32>(limX, new_px, new_px > limX);
    
    let new_py = select<f32>(pr, py, py < pr);
    new_py = select<f32>(limY, new_py, new_py > limY);

    // --- Velocity Bounce ---
    // Wenn px < pr oder px > limX, invertiere vx
    let hitX = (px < pr) || (px > limX);
    let hitY = (py < pr) || (py > limY);
    
    let new_vx = select<f32>(-pvx, pvx, hitX);
    let new_vy = select<f32>(-pvy, pvy, hitY);

    store<f32>(ptr_x + off, new_px);
    store<f32>(ptr_y + off, new_py);
    store<f32>(ptr_vx + off, new_vx);
    store<f32>(ptr_vy + off, new_vy);
}

export function updateMovementParallel(start: i32, end: i32, dt: f32, width: f32, height: f32): void {
    let i = start;
    let simdEnd = start + ((end - start) >> 2 << 2);

    if (simdEnd > i) {
        let dt_vec          = f32x4.splat(dt);
        let ambient_vec     = f32x4.splat(f32(20.0));
        let coolingRate_vec = f32x4.splat(f32(0.001) * dt); // dt schon drin → kein extra *dt nötig

        for (; i < simdEnd; i += 4) {
            let off = i * 4;

            v128.store(ptr_x    + off, f32x4.add(v128.load(ptr_x  + off), f32x4.mul(v128.load(ptr_vx + off), dt_vec)));
            v128.store(ptr_y    + off, f32x4.add(v128.load(ptr_y  + off), f32x4.mul(v128.load(ptr_vy + off), dt_vec)));

            // Temperatur-Abkühlung (SIMD)
            let t_vec = v128.load(ptr_temp + off);
            v128.store(ptr_temp + off, f32x4.add(t_vec, f32x4.mul(f32x4.sub(ambient_vec, t_vec), coolingRate_vec)));

            applySafeBranchlessWalls(i,     width, height);
            applySafeBranchlessWalls(i + 1, width, height);
            applySafeBranchlessWalls(i + 2, width, height);
            applySafeBranchlessWalls(i + 3, width, height);
        }
    }

    for (; i < end; i++) {
        let off = i * 4;
        store<f32>(ptr_x    + off, load<f32>(ptr_x    + off) + load<f32>(ptr_vx   + off) * dt);
        store<f32>(ptr_y    + off, load<f32>(ptr_y    + off) + load<f32>(ptr_vy   + off) * dt);
        let t = load<f32>(ptr_temp + off);
        store<f32>(ptr_temp + off, t + (f32(20.0) - t) * f32(0.001) * dt);
        applySafeBranchlessWalls(i, width, height);
    }
}

// ==========================================
// --- LOOP B: GRID REBUILD ---
// ==========================================

export function rebuildGrid(count: i32): void {
    let totalCells = gridCols * gridRows;
    let limitX = gridCols - 1;
    let limitY = gridRows - 1;

    memory.fill(ptr_cellCount, 0, totalCells * 4);
    memory.fill(ptr_tempCount, 0, totalCells * 4);

    // Phase 1: Counting
    for (let id = 0; id < count; id++) {
        let off = id * 4;
        let cx = i32(load<f32>(ptr_x + off) * invCellSize);
        let cy = i32(load<f32>(ptr_y + off) * invCellSize);

        cx = max(0, min(limitX, cx));
        cy = max(0, min(limitY, cy));

        let cellOff = (cy * gridCols + cx) * 4;
        store<i32>(ptr_cellCount + cellOff, load<i32>(ptr_cellCount + cellOff) + 1);
    }

    // Phase 2: Prefix Sum
    store<i32>(ptr_cellStart, 0);
    let cumulative: i32 = 0;
    for (let i = 0; i < totalCells; i++) {
        cumulative += load<i32>(ptr_cellCount + i * 4);
        store<i32>(ptr_cellStart + (i + 1) * 4, cumulative);
    }

    // Phase 3: Sort
    for (let id = 0; id < count; id++) {
        let off = id * 4;
        let cx = i32(load<f32>(ptr_x + off) * invCellSize);
        let cy = i32(load<f32>(ptr_y + off) * invCellSize);
        cx = max(0, min(limitX, cx));
        cy = max(0, min(limitY, cy));

        let cellOff = (cy * gridCols + cx) * 4;
        let start = load<i32>(ptr_cellStart + cellOff);
        let temp  = load<i32>(ptr_tempCount + cellOff);

        store<i32>(ptr_particleIndex + (start + temp) * 4, id);
        store<i32>(ptr_tempCount + cellOff, temp + 1);
    }
}

// Parallel

// Phase 1: Jedes Partikel erhöht den Zähler seiner Zelle (Parallel)
export function gridPhase1Parallel(start: i32, end: i32): void {
    let limitX = gridCols - 1;
    let limitY = gridRows - 1;

    for (let id = start; id < end; id++) {
        let off = id * 4;
        let cx = i32(load<f32>(ptr_x + off) * invCellSize);
        let cy = i32(load<f32>(ptr_y + off) * invCellSize);

        cx = max(0, min(limitX, cx));
        cy = max(0, min(limitY, cy));

        let cellOff = (cy * gridCols + cx) * 4;
        // Atomares Hinzufügen: Sicher gegen Race Conditions
        atomic.add<i32>(ptr_cellCount + cellOff, 1);
    }
}

// Phase 3: Partikel IDs in das sortierte Array schreiben (Parallel)
export function gridPhase3Parallel(start: i32, end: i32): void {
    let limitX = gridCols - 1;
    let limitY = gridRows - 1;

    for (let id = start; id < end; id++) {
        let off = id * 4;
        let cx = i32(load<f32>(ptr_x + off) * invCellSize);
        let cy = i32(load<f32>(ptr_y + off) * invCellSize);
        cx = max(0, min(limitX, cx));
        cy = max(0, min(limitY, cy));

        let cellOff = (cy * gridCols + cx) * 4;
        let cellStart = load<i32>(ptr_cellStart + cellOff);
        
        // atomic.add gibt den ALTEN Wert zurück. 
        // Das nutzen wir als individuellen Slot innerhalb der Zelle.
        let localIdx = atomic.add<i32>(ptr_tempCount + cellOff, 1);

        store<i32>(ptr_particleIndex + (cellStart + localIdx) * 4, id);
    }
}

// Hilfsfunktion für den Haupt-Thread: Prefix-Sum (Bleibt seriell)
export function gridPrefixSum(): void {
    let totalCells = gridCols * gridRows;
    store<i32>(ptr_cellStart, 0);
    let cumulative: i32 = 0;
    for (let i = 0; i < totalCells; i++) {
        cumulative += load<i32>(ptr_cellCount + i * 4);
        store<i32>(ptr_cellStart + (i + 1) * 4, cumulative);
    }
}

// Hilfsfunktion zum Leeren der Zähler
export function clearGridCounters(): void {
    let totalCells = gridCols * gridRows;
    memory.fill(ptr_cellCount, 0, totalCells * 4);
    memory.fill(ptr_tempCount, 0, totalCells * 4);
}

// ==========================================
// --- LOOP C: KOLLISIONEN ---
// ==========================================

// ==========================================
// --- LOOP C: KOLLISIONEN (4-PHASEN-SCHACHBRETT) ---
// ==========================================

export function checkCollisionsParallel(
    startRow: i32, 
    endRow: i32, 
    phase: i32,
    maxR: f32,
    restitution: f32, 
    heatRate: f32
): void {
    const gridLimitX = gridCols - 1;
    const gridLimitY = gridRows - 1;

    for (let cy = startRow; cy < endRow; cy++) {
        for (let cx = 0; cx < gridCols; cx++) {
            
            // NEU: 3x3 Checkerboard Logik (9 Phasen)
            // Phase = (Row % 3) * 3 + (Col % 3)
            if ((cy % 3) * 3 + (cx % 3) != phase) continue;

            let cellIdx = cy * gridCols + cx;
            let startA = load<i32>(ptr_cellStart + cellIdx * 4);
            let endA   = load<i32>(ptr_cellStart + (cellIdx + 1) * 4);

            for (let i = startA; i < endA; i++) {
                let idA = load<i32>(ptr_particleIndex + i * 4);
                let offA = idA * 4;
                
                let xA = load<f32>(ptr_x + offA);
                let yA = load<f32>(ptr_y + offA);
                let rA = load<f32>(ptr_r + offA);
                let invMassA = load<f32>(ptr_invMass + offA);

                // Suchradius: Muss groß genug sein, um Nachbarn zu finden!
                // Bei cellSize = 2*r ist rA + maxR (ca. 2.0) korrekt.
                let searchR = rA + maxR; 
                let x0 = max(0, min(gridLimitX, i32((xA - searchR) * invCellSize)));
                let x1 = max(0, min(gridLimitX, i32((xA + searchR) * invCellSize)));
                let y0 = max(0, min(gridLimitY, i32((yA - searchR) * invCellSize)));
                let y1 = max(0, min(gridLimitY, i32((yA + searchR) * invCellSize)));

                for (let ncy = y0; ncy <= y1; ncy++) {
                    for (let ncx = x0; ncx <= x1; ncx++) {
                        let nCellIdx = ncy * gridCols + ncx;
                        let startB = load<i32>(ptr_cellStart + nCellIdx * 4);
                        let endB   = load<i32>(ptr_cellStart + (nCellIdx + 1) * 4);

                        for (let j = startB; j < endB; j++) {
                            let idB = load<i32>(ptr_particleIndex + j * 4);
                            if (idA >= idB) continue;

                            let offB = idB * 4;
                            let dx = load<f32>(ptr_x + offB) - xA;
                            let dy = load<f32>(ptr_y + offB) - yA;
                            let distSq = dx * dx + dy * dy;
                            let rB = load<f32>(ptr_r + offB);
                            let minDist = rA + rB;

                            if (distSq < minDist * minDist) {
                                let dist = Mathf.sqrt(distSq);
                                if (dist == f32(0)) dist = f32(0.0001);

                                let nx = dx / dist;
                                let ny = dy / dist;
                                let overlap = minDist - dist;

                                let invMassB = load<f32>(ptr_invMass + offB);
                                let invMassSum = invMassA + invMassB;
                                
                                // --- Position Korrektur (Anti-Clumping) ---
                                let ratioA = invMassA / invMassSum;
                                let ratioB = invMassB / invMassSum;

                                xA -= nx * overlap * ratioA;
                                yA -= ny * overlap * ratioA;
                                store<f32>(ptr_x + offA, xA);
                                store<f32>(ptr_y + offA, yA);
                                
                                store<f32>(ptr_x + offB, load<f32>(ptr_x + offB) + (nx * overlap * ratioB));
                                store<f32>(ptr_y + offB, load<f32>(ptr_y + offB) + (ny * overlap * ratioB));

                                // --- Impuls-Antwort ---
                                let vax = load<f32>(ptr_vx + offA);
                                let vay = load<f32>(ptr_vy + offA);
                                let vbx = load<f32>(ptr_vx + offB);
                                let vby = load<f32>(ptr_vy + offB);

                                let relVelX = vbx - vax;
                                let relVelY = vby - vay;
                                let velAlongNormal = relVelX * nx + relVelY * ny;

                                if (velAlongNormal < f32(0)) {
                                    let j = -(f32(1.0) + restitution) * velAlongNormal / invMassSum;

                                    store<f32>(ptr_vx + offA, vax - (j * nx * invMassA));
                                    store<f32>(ptr_vy + offA, vay - (j * ny * invMassA));
                                    store<f32>(ptr_vx + offB, vbx + (j * nx * invMassB));
                                    store<f32>(ptr_vy + offB, vby + (j * ny * invMassB));

                                    // --- Temperaturtransfer ---
                                    let tA = load<f32>(ptr_temp + offA);
                                    let tB = load<f32>(ptr_temp + offB);
                                    let energy = (tB - tA) * heatRate;

                                    store<f32>(ptr_temp + offA, tA + (energy * invMassA));
                                    store<f32>(ptr_temp + offB, tB - (energy * invMassB));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

let ptr_renderBuffer: usize;

export function initRenderPointer(ptr: usize): void {
    ptr_renderBuffer = ptr;
}

export function updateRenderBuffer(count: i32): void {
    let i = 0;
    let simdEnd = count >> 2 << 2; // Abrunden auf Vielfaches von 4

    for (; i < simdEnd; i += 4) {
        let byteOffset   = i * 4;
        let renderOffset = i * 8;

        let x_vec = v128.load(ptr_x + byteOffset);
        let y_vec = v128.load(ptr_y + byteOffset);

        v128.store(ptr_renderBuffer + renderOffset,      i8x16.shuffle(x_vec, y_vec,  0, 1, 2, 3, 16,17,18,19,  4, 5, 6, 7, 20,21,22,23));
        v128.store(ptr_renderBuffer + renderOffset + 16, i8x16.shuffle(x_vec, y_vec,  8, 9,10,11, 24,25,26,27, 12,13,14,15, 28,29,30,31));
    }

    // Tail: restliche 1-3 Partikel skalär abarbeiten
    for (; i < count; i++) {
        let off          = i * 4;
        let renderOffset = i * 8;
        store<f32>(ptr_renderBuffer + renderOffset,     load<f32>(ptr_x + off));
        store<f32>(ptr_renderBuffer + renderOffset + 4, load<f32>(ptr_y + off));
    }
}