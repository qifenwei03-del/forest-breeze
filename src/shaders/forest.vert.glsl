// Fullscreen quad（contain 模式）。
//
// 這裡「刻意」不使用 modelViewMatrix / projectionMatrix：
// geometry 是 PlaneGeometry(2, 2)，position.xy 已經正好是 clip space 的 -1..1。
// 只乘上 uQuadScale 把整張圖等比縮到視窗內（contain / letterbox），
// 其餘部分維持 renderer 的黑色 clear color。
//
// 這保證相機在數學上不可能移動、不可能 zoom、不可能產生透視位移，
// 而且圖片永遠維持原始長寬比（1:1），絕不 stretch。
//
// 注意：position / uv 這兩個 attribute 由 THREE.ShaderMaterial 自動注入，不要重複宣告。

uniform vec2 uQuadScale;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * uQuadScale, 0.0, 1.0);
}
