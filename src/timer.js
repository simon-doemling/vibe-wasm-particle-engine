export default class Timer {
  constructor() {
    this.time = 0;
    this.running = false;
    this.paused = false;
    this.stopped = true;
    this.collection = []; // In JS ist eine LinkedList einfach ein Array
    this.collecting = false;
    this.collectingStopped = true;
    this.collectionMaxSize = 100;
    this.lastMeasurementIndex = -1;
    this.startMark = 0; // "start" ist ein reserviertes Wort in manchen Kontexten, daher "startMark"
  }

  // Hilfsfunktion: Gibt aktuelle Zeit in simulierten Nanosekunden zurück
  _getNow() {
    // performance.now() gibt Millisekunden zurück (z.B. 1500.005)
    // Wir multiplizieren mit 1.000.000 für Nanosekunden-Skala
    return window.performance.now() * 1000000;
  }

  start() {
    if (!this.running) {
      if (this.stopped) {
        this.time = 0;
        this.stopped = false;
      }
      this.startMark = this._getNow();
      this.running = true;
      this.paused = false;
    }
    return this;
  }

  pause() {
    if (this.running && !this.paused) {
      this.time += this._getNow() - this.startMark;
      this.running = false;
      this.paused = true;
    }
    return this;
  }

  stop() {
    if (!this.stopped) {
      if (this.running && !this.paused) {
        this.time += this._getNow() - this.startMark;
      }
      this.running = false;
      this.paused = false;
      this.stopped = true;
      if (this.collecting) {
        let i = (this.lastMeasurementIndex + 1) % this.collectionMaxSize;
        this.lastMeasurementIndex = i;
        if(this.collection.length < i)
          this.collection.push(this.time);
        else
          this.collection[i] = this.time;
        // addFirst in Java entspricht unshift in JS
        //this.collection.unshift(this.time);
        //if(this.collection.length > this.collectionMaxSize)
        // this.removeLast();
      }
    }
    return this;
  }

  getNanos() {
    if (this.running && !this.paused) {
      const currentNanos = this._getNow();
      this.time += currentNanos - this.startMark;
      this.startMark = currentNanos;
    }
    return this.time;
  }

  getMicros() { return this.getNanos() / 1000; }
  getMillis() { return this.getNanos() / 1000000; }
  getSeconds() { return this.getNanos() / 1000000000; }


  // --- Collection Methoden ---

  startCollection() {
    if (this.collectingStopped) {
      this.collection = [];
    }
    this.collecting = true;
    return this;
  }

  pauseCollection() {
    this.collecting = false;
    return this;
  }

  stopCollection() {
    this.collecting = false;
    this.collectingStopped = true;
    return this;
  }

  clearCollection() {
    this.collection = [];
    return this;
  }

  removeFirst() {
    this.collection.shift(); // Entfernt das erste Element
  }

  removeLast() {
    this.collection.pop(); // Entfernt das letzte Element
  }

  getCollection() {
    // Gibt eine Kopie des Arrays zurück
    return [...this.collection];
  }

  // --- Statistik Methoden ---

  getMinNanos() {
    if (this.collection.length === 0) return 0;
    let min = Number.MAX_VALUE;
    for (let t of this.collection) {
      if (t < min) min = t;
    }
    return min;
  }
  getMinMicros() { return this.getMinNanos() / 1000; }
  getMinMillis() { return this.getMinNanos() / 1000000; }
  getMinSeconds() { return this.getMinNanos() / 1000000000; }

  getMaxNanos() {
    if (this.collection.length === 0) return 0;
    // Number.MIN_VALUE in JS ist die kleinste positive Zahl, 
    // für negative Vergleiche besser -Number.MAX_VALUE oder Startwert 0 nehmen
    let max = -Number.MAX_VALUE; 
    for (let t of this.collection) {
      if (t > max) max = t;
    }
    return max;
  }
  getMaxMicros() { return this.getMaxNanos() / 1000; }
  getMaxMillis() { return this.getMaxNanos() / 1000000; }
  getMaxSeconds() { return this.getMaxNanos() / 1000000000; }

  getAvgNanos() {
    if (this.collection.length < 1) return 0;
    let sum = 0;
    for (let t of this.collection) {
      sum += t;
    }
    return sum / this.collection.length;
  }
  getAvgMicros() { return this.getAvgNanos() / 1000; }
  getAvgMillis() { return this.getAvgNanos() / 1000000; }
  getAvgSeconds() { return this.getAvgNanos() / 1000000000; }
}