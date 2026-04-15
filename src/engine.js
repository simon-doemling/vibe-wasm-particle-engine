import { Application } from "pixi.js";

export const app = new Application();

export async function initEngine() {
    await app.init({
        background: 'rgba(0, 67, 112, 1)',
        resizeTo: window,
        antialias: true
    });

    app.canvas.style.position = 'absolute';

    app.stage.eventMode = 'static';
    app.stage.hitArea = app.screen;
    
    app.ticker.maxFPS = 360;

    document.body.appendChild(app.canvas);

    console.log("Pixi engine ready!");
}