let wasm;

onmessage = async (e) => {
    const { type, module, memory, id, pointers, grid, start, end, params } = e.data;

    if (type === 'init') {
        const instance = await WebAssembly.instantiate(module, {
            env: { memory, abort: () => {} }
        });
        wasm = instance.exports;

        // Pointer & Grid initialisieren
        wasm.initPointers(
            pointers.x, pointers.y, pointers.vx, pointers.vy,
            pointers.r, pointers.invMass, pointers.temp
        );
        wasm.initGrid(
            grid.cellCount, grid.cellStart, grid.particleIndex, grid.tempCount,
            grid.cols, grid.rows, grid.cellSize
        );

        postMessage({ type: 'ready' });
        return; // Frühzeitiger Abbruch, damit kein "done" gesendet wird
    }

    // --- PHYSIK AUFGABEN ---

    if (type === 'work_movement') {
        // Hier sind start/end weiterhin Partikel-Indizes
        wasm.updateMovementParallel(start, end, params.dt, params.width, params.height);
    } 
    
    else if (type === 'work_collision') {
        // WICHTIG: Hier sind start/end jetzt ZEILEN-Indizes (startRow, endRow)
        // Wir übergeben zusätzlich die 'phase' (0, 1, 2 oder 3)
        wasm.checkCollisionsParallel(start, end, params.phase, params.maxR, params.restitution, params.heatRate);
    }

    // --- GRID AUFGABEN ---

    else if (type === 'grid_p1') {
        wasm.gridPhase1Parallel(start, end);
    } 

    else if (type === 'grid_p3') {
        wasm.gridPhase3Parallel(start, end);
    }

    // Allen Aufgaben gemeinsam: Wenn fertig, Rückmeldung an Main-Thread
    postMessage({ type: 'done' });
};