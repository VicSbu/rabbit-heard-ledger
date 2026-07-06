const fs = require('fs/promises');
const path = require('path');
const { minify } = require('terser');
const JavaScriptObfuscator = require('javascript-obfuscator');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const runtimeDir = path.join(__dirname, 'runtime');

const baseObfuscation = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.85,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

const runtimeObfuscation = {
  ...baseObfuscation,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.2,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.05,
  numbersToExpressions: true,
};

const configObfuscation = {
  ...baseObfuscation,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: false,
};

async function buildOne(inputName, outputName, obfuscationOptions) {
  const inputPath = path.join(srcDir, inputName);
  const outputPath = path.join(runtimeDir, outputName);
  const source = await fs.readFile(inputPath, 'utf8');
  const result = await minify(source, {
    compress: true,
    mangle: true,
    format: {
      ascii_only: true,
      comments: false,
    },
  });

  if (!result.code) {
    throw new Error('Minification produced no output for ' + inputName);
  }

  const obfuscated = JavaScriptObfuscator.obfuscate(result.code, obfuscationOptions).getObfuscatedCode();

  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(outputPath, obfuscated, 'utf8');
}

async function main() {
  await buildOne('firebase-config.js', 'firebase-config.js', configObfuscation);
  await buildOne('app.js', 'app.js', runtimeObfuscation);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});