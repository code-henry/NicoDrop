import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('assets/fonts', { recursive: true });
await mkdir('licenses', { recursive: true });
const files = [
  ['https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Bold.otf', 'assets/fonts/NotoSansCJKjp-Bold.otf'],
  ['https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE', 'licenses/Noto-OFL.txt'],
];
for (const [url, destination] of files) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
  console.log(destination);
}
