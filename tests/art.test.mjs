// Artwork addresses (LMS.art in src/app/lms.js): what the page asks LMS for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// lms.js is a fragment of the app's script: take the class (and its helper) out of it.
const src = readFileSync(new URL('../src/app/lms.js', import.meta.url), 'utf8');
const cls = src.slice(src.indexOf('const isSvg'), src.lastIndexOf('}') + 1);
const lms = vm.runInNewContext(cls + '; new LMS()', { location: { href: 'http://lms:9000/plugins/LyrionJS/', origin: 'http://lms:9000' }, URL });

const TUNEIN = 'http%3A%2F%2Fcdn-profiles.tunein.com%2Fs244231%2Fimages%2Flogoq.png%3Ft%3D1088';

test('proxied images as LMS hands them out are asked for at a size (LMS redirects full size ones off-site)', () => {
  assert.equal(lms.art(`/imageproxy/${TUNEIN}/image.png`, 120), `/imageproxy/${TUNEIN}/image_120x120_f.png`);
  assert.equal(lms.art('/imageproxy/https%3A%2F%2Fx.example%2Fa.jpg/image.jpg', 96), '/imageproxy/https%3A%2F%2Fx.example%2Fa.jpg/image_96x96_f.jpg');
  assert.equal(lms.art('imageproxy/http%3A%2F%2Fx.example%2Fa.gif/image.gif', 96), '/imageproxy/http%3A%2F%2Fx.example%2Fa.gif/image_96x96_f.png');
  assert.equal(lms.art('/imageproxy/http%3A%2F%2Fx.example%2Fa/image', 50), '/imageproxy/http%3A%2F%2Fx.example%2Fa/image_50x50_f.png');
});

test('proxied images that already have a size are left alone', () => {
  assert.equal(lms.art(`/imageproxy/${TUNEIN}/image_300x300_f.png`, 120), `/imageproxy/${TUNEIN}/image_300x300_f.png`);
});

test('images on other hosts go through the image proxy, at a size', () => {
  assert.equal(lms.art('https://x.example/logo.png?a=1', 120), '/imageproxy/https%3A%2F%2Fx.example%2Flogo.png%3Fa%3D1/image_120x120_f.png');
  assert.equal(lms.art('//x.example/a.png', 96), '/imageproxy/http%3A%2F%2Fx.example%2Fa.png/image_96x96_f.png');
});

test('paths on the server stay as they are; covers get a size; other schemes are refused', () => {
  assert.equal(lms.art('plugins/TuneIn/html/images/radiolocal.png'), '/plugins/TuneIn/html/images/radiolocal.png');
  assert.equal(lms.art('/html/images/radio.png'), '/html/images/radio.png');
  assert.equal(lms.art('music/abc123/cover', 120), '/music/abc123/cover_120x120_f');
  assert.equal(lms.art('javascript:alert(1)'), null);
  assert.equal(lms.art('data:image/png;base64,AAAA'), null);
  assert.equal(lms.art(''), null);
});

test('SVGs, which LMS\'s image proxy sends off-site, go through the plugin', () => {
  const svg = 'https://x.example/logos/r1.svg?v=2', via = '/plugins/LyrionJS/svg?u=' + encodeURIComponent(svg);
  assert.equal(lms.art(svg, 120), via);
  assert.equal(lms.art('/imageproxy/' + encodeURIComponent(svg) + '/image.png', 120), via);
  assert.equal(lms.art('imageproxy/' + encodeURIComponent(svg) + '/image_300x300_f.png', 120), via);
  assert.equal(lms.art('https://x.example/svg/logo.png', 96), '/imageproxy/https%3A%2F%2Fx.example%2Fsvg%2Flogo.png/image_96x96_f.png');
  assert.equal(lms.art('https://x.example/logo.png?f=a.svg', 96), '/imageproxy/https%3A%2F%2Fx.example%2Flogo.png%3Ff%3Da.svg/image_96x96_f.png');
  assert.equal(lms.art('/imageproxy/%E0%A4%A/image.png', 96), '/imageproxy/%E0%A4%A/image_96x96_f.png');   // not decodable: as it is
});
