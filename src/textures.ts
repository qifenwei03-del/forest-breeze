import * as THREE from 'three';
import { TEXTURE_QUALITY } from './config';

export interface LoadedTexture {
  texture: THREE.Texture;
  /** 原生像素寬度（未經任何縮小）。 */
  width: number;
  /** 原生像素高度（未經任何縮小）。 */
  height: number;
}

/**
 * 載入一張圖片並包成 THREE.Texture。
 *
 * 這裡「絕對不會」對圖片做 resize / canvas 重繪 / drawImage 縮圖。
 * HTMLImageElement 直接交給 WebGL，texImage2D 上傳的就是原生解析度。
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`無法載入圖片：${url}`));
    img.src = url;
  });
}

/** forest.jpg —— 用於顯示的照片。 */
export async function loadPhotoTexture(url: string): Promise<LoadedTexture> {
  const img = await loadImage(url);
  const texture = new THREE.Texture(img);

  // 不做任何色彩轉換：取樣到的值就是 JPEG 原始的 sRGB 位元組值，
  // 直接寫進 gl_FragColor。位移為 0 時，畫面 = 原圖，逐像素相同。
  texture.colorSpace = THREE.NoColorSpace;

  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;

  // mipmap 不會降低 level 0 的解析度 —— level 0 永遠是原生 4096²。
  // 它只在「畫面顯示尺寸 < texture 尺寸」時提供正確的縮小取樣，
  // 避免葉片產生 aliasing 閃爍（那種閃爍會被誤認為 flicker）。
  texture.generateMipmaps = TEXTURE_QUALITY.mipmaps;
  texture.minFilter = TEXTURE_QUALITY.mipmaps
    ? THREE.LinearMipmapLinearFilter
    : THREE.LinearFilter;

  texture.needsUpdate = true;

  return { texture, width: img.naturalWidth, height: img.naturalHeight };
}

/** movement-mask.png —— 只讀 luminance，不能被當成 sRGB 解碼。 */
export async function loadMaskTexture(url: string): Promise<LoadedTexture> {
  const img = await loadImage(url);
  const texture = new THREE.Texture(img);

  // NoColorSpace：PNG 的 128 灰階要維持在 ~0.502，而不是被 sRGB->linear 變成 0.216。
  texture.colorSpace = THREE.NoColorSpace;

  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * mask 載入失敗時的替代品：1×1 全黑。
 * 全黑 = 完全不動 = 直接退化成靜態照片，頁面不會崩潰。
 */
export function createFallbackMask(): LoadedTexture {
  const data = new Uint8Array([0, 0, 0, 255]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, width: 1, height: 1 };
}
