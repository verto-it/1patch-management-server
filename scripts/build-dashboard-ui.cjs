// AGPL-3.0-only
const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const ts = require('typescript');

const root = join(__dirname, '..');
const uiRoot = join(root, 'src', 'dashboard-ui');
const files = [
  'mini-react.js',
  'tweaks-panel.jsx',
  'api.jsx',
  'primitives.jsx',
  'pages.jsx',
  'app.jsx',
];

const chunks = files.map((file) => {
  const source = readFileSync(join(uiRoot, file), 'utf8');
  if (!file.endsWith('.jsx')) return source;
  const out = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      removeComments: false,
    },
    fileName: file,
  });
  return out.outputText;
});

writeFileSync(
  join(uiRoot, 'app.bundle.js'),
  `${chunks.join('\n\n')}\n//# sourceURL=/ui/app.bundle.js\n`,
  'utf8',
);
