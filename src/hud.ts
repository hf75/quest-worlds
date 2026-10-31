import * as THREE from 'three';

/** Kleine Anzeige für die Bildrate. Im Headset gibt es keine Konsole, und die Bildrate ist die wichtigste offene Frage. */
export class Hud {
  readonly panel: THREE.Mesh;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private frames = 0;
  private worst = 0;
  private last = performance.now();

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 168;
    this.ctx = canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.138),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.panel.position.set(0, -0.28, -0.9);
    this.panel.rotation.x = -0.25;
    this.panel.renderOrder = 100;
    this.panel.visible = false;
  }

  toggle() {
    this.panel.visible = !this.panel.visible;
  }

  update(dtMs: number, patches: number, exposure: number, seed: number, note: string) {
    this.frames++;
    this.worst = Math.max(this.worst, dtMs);
    const now = performance.now();
    if (now - this.last < 500) return;
    const fps = (this.frames * 1000) / (now - this.last);
    if (this.panel.visible) {
      const c = this.ctx;
      c.clearRect(0, 0, 512, 168);
      c.fillStyle = 'rgba(8,10,14,.78)';
      c.fillRect(0, 0, 512, 168);
      c.fillStyle = '#e6dcc8';
      c.font = '600 44px system-ui, sans-serif';
      c.fillText(`${fps.toFixed(0)} FPS  ·  max ${this.worst.toFixed(0)} ms`, 18, 56);
      c.font = '30px system-ui, sans-serif';
      c.fillStyle = '#aab1bf';
      c.fillText(`Exposure ${exposure.toFixed(2)}  ·  Patches ${patches}  ·  World ${seed}`, 18, 106);
      c.fillText(note, 18, 148);
      this.texture.needsUpdate = true;
    }
    this.frames = 0;
    this.worst = 0;
    this.last = now;
  }
}
