import * as THREE from 'three';

let done = 0;
let total = 0;
let onProgress: (fraction: number) => void = () => {};

/** Beginnt eine neue Zählung: Jeder Ladevorgang läuft von vorn bis 100 %. */
export function trackProgress(fn: (fraction: number) => void) {
  done = 0;
  total = 0;
  onProgress = fn;
}

async function tracked<T>(work: Promise<T>): Promise<T> {
  total++;
  const result = await work;
  done++;
  onProgress(done / total);
  return result;
}

export function fetchBinary(url: string): Promise<ArrayBuffer> {
  return tracked(fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.arrayBuffer();
  }));
}

export function fetchJson<T>(url: string): Promise<T> {
  return tracked(fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json() as Promise<T>;
  }));
}

// Datenkarten dürfen weder vormultipliziert noch farbkonvertiert werden, sonst stimmen Normalen und Masken nicht mehr
export function fetchBitmap(url: string): Promise<ImageBitmap> {
  return tracked(fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }));
}

export function tileTexture(image: ImageBitmap, srgb: boolean, anisotropy: number): THREE.Texture {
  const t = new THREE.Texture(image);
  t.flipY = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// Mipmaps für R16F verlangen, dass das Format renderbar ist. Ohne die Erweiterung wird gröber abgetastet,
// was in der Ferne etwas flimmert, aber läuft.
export function heightTexture(data: Uint16Array, size: number, canMip: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.HalfFloatType);
  t.internalFormat = 'R16F';
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = canMip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = canMip;
  t.needsUpdate = true;
  return t;
}
