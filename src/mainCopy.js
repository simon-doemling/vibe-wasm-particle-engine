import { Graphics, Text, Sprite } from "pixi.js";
import { app, initEngine } from "./engine.js";
import Timer from "./timer.js";

// --- HILFSFUNKTIONEN ---
function fastRemove(array, index) {
  if (index === -1) return false;
  if (index === array.length - 1) {
    array.pop();
    return true;
  }
  array[index] = array[array.length - 1];
  array.pop();
  return true;
}

// --- DAS GRID (Kennt nur noch IDs, keine Objekte!) ---
class SpatialHashGridSoA {
  constructor(width, height, cellSize, maxEntities) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.COLS = Math.floor(width / cellSize) + 1;
    this.ROWS = Math.floor(height / cellSize) + 1;

    // Das flache Array für die Buckets
    this.cells = [];
    for (let i = 0; i < this.COLS * this.ROWS; i++) {
      this.cells[i] = [];
    }
    
    // DER SHARED BUFFER: Verhindert Garbage Collection beim Suchen
    this.queryResultBuffer = new Uint32Array(maxEntities);
  }

  insert(id, gx, gy, gw, gh) {
    for (let x = gx; x <= gx + gw; x++) {
      for (let y = gy; y <= gy + gh; y++) {
        this.cells[this.COLS * y + x].push(id);
      }
    }
  }

  remove(id, gx, gy, gw, gh) {
    for (let x = gx; x <= gx + gw; x++) {
      for (let y = gy; y <= gy + gh; y++) {
        let items = this.cells[this.COLS * y + x];
        let index = items.indexOf(id);
        fastRemove(items, index);
      }
    }
  }

  findNearby(id, gx, gy, gw, gh) {
    let count = 0; // Wie viele Nachbarn gefunden wurden
    
    for (let ix = 0; ix <= gw; ix++) {
      for (let iy = 0; iy <= gh; iy++) {
        let x = gx + ix;
        let y = gy + iy;
        
        if (x < 0 || x >= this.COLS || y < 0 || y >= this.ROWS) continue;

        let items = this.cells[this.COLS * y + x];
        for (let i = 0; i < items.length; i++) {
          let otherId = items[i];
          if (otherId !== id) {
            this.queryResultBuffer[count++] = otherId;
          }
        }
      }
    }
    return count; 
  }
}

// --- DAS SYSTEM (Structure of Arrays) ---
class ParticleSystem {
  constructor(width, height, maxParticles, cellWidth) {
    this.max = maxParticles;
    this.count = 0;
    this.cellWidth = cellWidth;
    this.grid = new SpatialHashGridSoA(width, height, cellWidth, maxParticles);

    // Physikalische Eigenschaften (Jedes Array ist ein durchgehender Speicherblock)
    this.x = new Float32Array(maxParticles);
    this.y = new Float32Array(maxParticles);
    this.vx = new Float32Array(maxParticles);
    this.vy = new Float32Array(maxParticles);
    this.r = new Float32Array(maxParticles);
    this.mass = new Float32Array(maxParticles);
    this.invMass = new Float32Array(maxParticles);
    this.temp = new Float32Array(maxParticles);

    // Grid-Cache
    this.gridX = new Int32Array(maxParticles);
    this.gridY = new Int32Array(maxParticles);
    this.gridW = new Int32Array(maxParticles);
    this.gridH = new Int32Array(maxParticles);

    // NoUpdateZone (Hysterese)
    this.zoneLeft = new Float32Array(maxParticles);
    this.zoneRight = new Float32Array(maxParticles);
    this.zoneTop = new Float32Array(maxParticles);
    this.zoneBottom = new Float32Array(maxParticles);

    // Graphics
    const tempGraphic = new Graphics();
    tempGraphic.circle(0, 0, cellWidth);
    tempGraphic.fill(0xffffff);
    this.texture = app.renderer.generateTexture(tempGraphic);
    this.sprites = [];
  }

  // Ersetzt "new Particle()"
  spawn(x, y, vx, vy, r, temp) {
    if (this.count >= this.max) return -1;
    let id = this.count++;

    this.x[id] = x;
    this.y[id] = y;
    this.vx[id] = vx;
    this.vy[id] = vy;
    this.r[id] = r;
    this.mass[id] = r * r; // Masse basiert auf Fläche
    this.invMass[id] = r > 0 ? 1 / this.mass[id] : 0;
    this.temp[id] = temp;

    const sprite = new Sprite(this.texture);
    sprite.anchor.set(0.5);
    sprite.scale.set(this.r[id] / this.cellWidth);
    sprite.tint = 0xaaaaaa;

    this.sprites.push(sprite);
    app.stage.addChild(sprite);

    this._updateGridZone(id);
    this.grid.insert(id, this.gridX[id], this.gridY[id], this.gridW[id], this.gridH[id]);
    return id;
  }

  _updateGridZone(id) {
    let px = this.x[id];
    let py = this.y[id];
    let pr = this.r[id];
    let cW = this.grid.cellSize;
    let iCW = this.grid.invCellSize;

    let left = px - pr;
    let right = px + pr;
    let top = py - pr;
    let bottom = py + pr;

    let leftGrid = Math.floor(left * iCW);
    let rightGrid = Math.floor(right * iCW);
    let topGrid = Math.floor(top * iCW);
    let bottomGrid = Math.floor(bottom * iCW);

    this.gridX[id] = Math.max(0, Math.min(this.grid.COLS - 1, leftGrid));
    this.gridY[id] = Math.max(0, Math.min(this.grid.ROWS - 1, topGrid));
    this.gridW[id] = Math.max(0, Math.min(this.grid.COLS - 1 - this.gridX[id], rightGrid - this.gridX[id]));
    this.gridH[id] = Math.max(0, Math.min(this.grid.ROWS - 1 - this.gridY[id], bottomGrid - this.gridY[id]));

    // Die "Fat Bounds" / Toleranzzone berechnen
    this.zoneLeft[id] = px - (left - leftGrid * cW);
    this.zoneRight[id] = px + ((1 + rightGrid) * cW - right);
    this.zoneTop[id] = py - (top - topGrid * cW);
    this.zoneBottom[id] = py + ((1 + bottomGrid) * cW - bottom);
  }

  update(dt, width, height) {
    let ambientTemp = 20.0;
    let coolingRate = 0.5;

    // 1. BEWEGUNG & GRID UPDATE
    for (let id = 0; id < this.count; id++) {
      //this.vy[id] += 100 * dt;
      this.x[id] += this.vx[id] * dt;
      this.y[id] += this.vy[id] * dt;

      // Abkühlung an die Umgebung
      this.temp[id] += (ambientTemp - this.temp[id]) * coolingRate * dt;

      // Abprallen an den Wänden
      if (this.x[id] < this.r[id]) { this.x[id] = this.r[id]; this.vx[id] *= -1; }
      if (this.x[id] > width - this.r[id]) { this.x[id] = width - this.r[id]; this.vx[id] *= -1; }
      if (this.y[id] < this.r[id]) { this.y[id] = this.r[id]; this.vy[id] *= -1; }
      if (this.y[id] > height - this.r[id]) { this.y[id] = height - this.r[id]; this.vy[id] *= -1; }

      // Zonen-Check (Nur ins Grid schreiben, wenn nötig)
      let px = this.x[id];
      let py = this.y[id];
      if (px < this.zoneLeft[id] || px > this.zoneRight[id] || py < this.zoneTop[id] || py > this.zoneBottom[id]) {
        this.grid.remove(id, this.gridX[id], this.gridY[id], this.gridW[id], this.gridH[id]);
        this._updateGridZone(id);
        this.grid.insert(id, this.gridX[id], this.gridY[id], this.gridW[id], this.gridH[id]);
      }
    }

    // 2. KOLLISIONEN & THERMODYNAMIK (Batched)
    let heatTransferRate = 0.5; 
    let restitution = 0.99; // 1 = perfekter Flummi, 0 = Matsch

    for (let idA = 0; idA < this.count; idA++) {
      // Füllt den shared Buffer mit allen potenziellen Nachbarn
      let neighborCount = this.grid.findNearby(idA, this.gridX[idA], this.gridY[idA], this.gridW[idA], this.gridH[idA]);

      for (let i = 0; i < neighborCount; i++) {
        let idB = this.grid.queryResultBuffer[i];

        // idA < idB garantiert, dass jedes Paar pro Frame exakt 1x geprüft wird!
        if (idA < idB) {
          let dx = this.x[idB] - this.x[idA];
          let dy = this.y[idB] - this.y[idA];
          let distSq = dx * dx + dy * dy;
          let minDist = this.r[idA] + this.r[idB];

          if (distSq < minDist * minDist) {
            let dist = Math.sqrt(distSq);
            if (dist === 0) dist = 0.0001; 

            // 2.1 Positionale Korrektur (verhindert das ineinander Versinken)
            let overlap = minDist - dist;
            let nx = dx / dist;
            let ny = dy / dist;

            let totalMass = this.mass[idA] + this.mass[idB];
            let ratioA = this.mass[idB] / totalMass;
            let ratioB = this.mass[idA] / totalMass;

            this.x[idA] -= nx * overlap * ratioA;
            this.y[idA] -= ny * overlap * ratioA;
            this.x[idB] += nx * overlap * ratioB;
            this.y[idB] += ny * overlap * ratioB;

            // 2.2 Impuls (Abprallen)
            let rvx = this.vx[idB] - this.vx[idA];
            let rvy = this.vy[idB] - this.vy[idA];
            let velAlongNormal = rvx * nx + rvy * ny;

            // Nur reagieren, wenn sie sich aufeinander zubewegen
            if (velAlongNormal < 0) {
              let j = -(1 + restitution) * velAlongNormal;
              j /= (this.invMass[idA] + this.invMass[idB]);

              let impulseX = j * nx;
              let impulseY = j * ny;

              this.vx[idA] -= impulseX * this.invMass[idA];
              this.vy[idA] -= impulseY * this.invMass[idA];
              this.vx[idB] += impulseX * this.invMass[idB];
              this.vy[idB] += impulseY * this.invMass[idB];

              // 2.3 Temperatur-Austausch bei Kontakt
              let tempDiff = this.temp[idB] - this.temp[idA];
              let energyExchange = tempDiff * heatTransferRate;

              this.temp[idA] += energyExchange * this.invMass[idA];
              this.temp[idB] -= energyExchange * this.invMass[idB];
            }
          }
        }
      }
    }
  }

  draw() {
    for(let id = 0; id < this.count; id++) {
      this.sprites[id].x = this.x[id];
      this.sprites[id].y = this.y[id];
    }
  }
}

async function startEngine() {
  await initEngine();

  let width = app.screen.width;
  let height = app.screen.height;

  let minR = 2;
  let maxR = 3;

  let system;
  let updateTimer, drawTimer, restTimer;
  let amount = 20000;

  system = new ParticleSystem(width, height, amount, maxR * 2);
  updateTimer = new Timer().startCollection();
  drawTimer = new Timer().startCollection();
  restTimer = new Timer().startCollection();

  for (let i = 0; i < amount; i++) {
    let r = minR + Math.random() * (maxR - minR);
    let x = r + Math.random() * (width - r);
    let y = r + Math.random() * (height - r);
    let vx = -100 + Math.random() * 200;
    let vy = -100 + Math.random() * 200;
    
    // Einige starten glühend heiß, andere raumkalt
    let temp = Math.random() > 0.95 ? 300 : 20; 
    
    system.spawn(x, y, vx, vy, r, temp);
  }

  const infoText = new Text({
      text: 'Partikel: 10000\nFPS: 60', // \n macht einen Zeilenumbruch
      style: {
          fontFamily: 'Arial',
          fontSize: 24,
          fill: 0xffffff,       // Weiße Schriftfarbe (Hex-Code)
          fontWeight: 'bold',
          dropShadow: true,     // Ein kleiner Schatten, damit man ihn auf den Partikeln lesen kann
          dropShadowColor: '#000000',
          dropShadowBlur: 4,
          dropShadowDistance: 2,
      }
  });

  // Position oben links mit etwas Abstand zum Rand
  infoText.x = 20;
  infoText.y = 20;

  // Ab auf die Bühne damit!
  app.stage.addChild(infoText);

  app.ticker.add((ticker) => {
    restTimer.stop();
    
    updateTimer.start();
    system.update(ticker.deltaMS * 0.001, width, height);
    updateTimer.stop();
    
    drawTimer.start();
    system.draw();
    drawTimer.stop();
    
    restTimer.start();

    const currentFPS = Math.round(app.ticker.FPS);
    const updateMS = updateTimer.getAvgMillis().toFixed(2);
    const drawMS = drawTimer.getAvgMillis().toFixed(2);
    const restMS = restTimer.getAvgMillis().toFixed(2);
    
    infoText.text = `Partikel: ${amount}\nFPS: ${currentFPS}\nUpdate: ${updateMS}\nDraw: ${drawMS}\nRest: ${restMS}`;
  });
}

startEngine();