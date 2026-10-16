// Loads the page's modules into globalThis.LJ for Node tests, in the order build.py inlines them.
const path = require('path');
const src = path.join(__dirname, '..', 'src');
const MODULES = {
  core: ['core/bytes.js', 'core/slimproto.js', 'core/decoder.js', 'core/flac.js', 'core/pcm.js', 'core/mp3.js', 'core/transition.js', 'core/player.js'],
  output: ['output/worklet.js', 'output/fmp4.js', 'output/webaudio.js'],
  host: ['host/transport.js'],
};
module.exports = function load(...groups) {
  for (const g of groups) for (const f of MODULES[g]) require(path.join(src, f));
  return globalThis.LJ;
};
module.exports.MODULES = MODULES;
