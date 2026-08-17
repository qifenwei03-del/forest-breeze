import { defineConfig } from 'vite';

// GitHub Pages 的 project site 位於 https://<user>.github.io/<repo>/，
// 所以正式建置時 base 必須是 '/<repo>/'，資源路徑才會正確。
// dev server 維持 '/'，本機開發不受影響。
const REPO_BASE = '/forest-breeze/';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? REPO_BASE : '/',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    // public/ 底下的檔案一律原樣複製，不做任何影像處理／壓縮／resize。
    // forest.png 與 movement-mask.png 必須放在 public/ 才能保證原始解析度。
    assetsInlineLimit: 0,
  },
}));
