const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const { SourceMapGenerator } = require('./source-map');

class Bundler {
  constructor(moduleGraph, options = {}) {
    this.graph = moduleGraph;
    this.options = options;
    this.outputDir = options.output || './dist';
    this.filename = options.filename || '[name].js';
    this.sourcemap = options.sourcemap !== false;
    this.format = options.format || 'esm';
    this.minify = options.minify || false;
    this.chunks = new Map();
    this.moduleIdMap = new Map();
    this._moduleIdCounter = 0;
  }

  bundle() {
    this._assignModuleIds();
    this._identifyChunks();
    const results = this._generateChunks();
    return results;
  }

  _assignModuleIds() {
    const topoOrder = this.graph.topologicalSort();
    for (const filePath of topoOrder) {
      const id = this._moduleIdCounter++;
      this.moduleIdMap.set(filePath, id);
    }
  }

  _identifyChunks() {
    const mainEntryModules = new Set(this.graph.entries);
    const dynamicEntryModules = new Set(this.graph.dynamicEntries);

    const mainModules = new Set();
    const chunkModules = new Map();

    const collectStaticDeps = (filePath, moduleSet, visited = new Set()) => {
      if (visited.has(filePath)) return;
      visited.add(filePath);
      const mod = this.graph.getModule(filePath);
      if (!mod) return;

      moduleSet.add(filePath);

      for (const dep of mod.dependencies) {
        if (!dynamicEntryModules.has(dep)) {
          collectStaticDeps(dep, moduleSet, visited);
        }
      }
    };

    for (const entry of this.graph.entries) {
      collectStaticDeps(entry, mainModules);
    }

    this.chunks.set('main', {
      name: 'main',
      modules: mainModules,
      isEntry: true,
    });

    const sharedModules = new Set();

    for (const dynEntry of this.graph.dynamicEntries) {
      const chunkMods = new Set();
      const visited = new Set();

      const collectChunkDeps = (filePath) => {
        if (visited.has(filePath)) return;
        visited.add(filePath);
        const mod = this.graph.getModule(filePath);
        if (!mod) return;

        if (mainModules.has(filePath)) {
          sharedModules.add(filePath);
          return;
        }

        chunkMods.add(filePath);

        for (const dep of mod.dependencies) {
          collectChunkDeps(dep);
        }
      };

      collectChunkDeps(dynEntry);

      const chunkName = path.basename(dynEntry, path.extname(dynEntry));
      this.chunks.set(chunkName, {
        name: chunkName,
        modules: chunkMods,
        isEntry: false,
        entryModule: dynEntry,
      });
    }

    if (sharedModules.size > 0) {
      this.chunks.set('shared', {
        name: 'shared',
        modules: sharedModules,
        isEntry: false,
        isShared: true,
      });

      for (const [, chunk] of this.chunks) {
        if (chunk.isShared) continue;
        const newModules = new Set();
        for (const mod of chunk.modules) {
          if (!sharedModules.has(mod)) {
            newModules.add(mod);
          }
        }
        chunk.modules = newModules;
      }
    }
  }

  _generateChunks() {
    const results = [];

    for (const [chunkName, chunk] of this.chunks) {
      const result = this._generateChunk(chunkName, chunk);
      results.push(result);
    }

    return results;
  }

  _generateChunk(chunkName, chunk) {
    const sourceMap = this.sourcemap
      ? new SourceMapGenerator({
          file: `${chunkName}.js`,
          sourceRoot: '',
        })
      : null;

    const moduleWrappers = [];
    const topoOrder = this.graph.topologicalSort();

    const sortedModulePaths = topoOrder.filter((p) => chunk.modules.has(p));

    let generatedLine = 1;

    for (const filePath of sortedModulePaths) {
      const mod = this.graph.getModule(filePath);
      if (!mod) continue;

      const moduleId = this.moduleIdMap.get(filePath);
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

      if (sourceMap) {
        sourceMap.addSourceContent(relativePath, mod.code);
      }

      const { wrapperCode, lineCount } = this._wrapModule(
        mod,
        moduleId,
        filePath,
        sourceMap,
        generatedLine,
        relativePath
      );

      moduleWrappers.push(wrapperCode);
      generatedLine += lineCount;
    }

    const chunkImports = this._generateChunkImports(chunkName, chunk);

    let output = '';
    if (chunkImports) {
      output += chunkImports + '\n';
    }

    output += this._generateRuntime(chunkName, chunk);

    for (const wrapper of moduleWrappers) {
      output += wrapper + '\n';
    }

    output += this._generateEntryCall(chunkName, chunk, sortedModulePaths);

    if (sourceMap) {
      const comment = sourceMap.toComment();
      output += '\n' + comment;
    }

    return {
      name: chunkName,
      code: output,
      sourcemap: sourceMap ? sourceMap.toJSON() : null,
      isEntry: chunk.isEntry,
      isShared: chunk.isShared || false,
      modules: sortedModulePaths,
    };
  }

  _wrapModule(mod, moduleId, filePath, sourceMap, startLine, relativePath) {
    const deps = mod.imports
      .filter((imp) => imp.resolvedPath)
      .map((imp) => {
        const depId = this.moduleIdMap.get(imp.resolvedPath);
        const specifierNames = imp.specifiers.map((s) => s.local);
        return { id: depId, names: specifierNames };
      });

    const transformedCode = this._transformModuleCode(mod, moduleId);

    if (sourceMap) {
      const codeLines = transformedCode.split('\n');
      for (let i = 0; i < codeLines.length; i++) {
        const originalLine = this._findOriginalLine(mod, i + 1);
        if (originalLine) {
          sourceMap.addMapping({
            generated: { line: startLine + 2 + i, column: 0 },
            original: { line: originalLine, column: 0 },
            source: relativePath,
          });
        }
      }
    }

    const wrapperCode = `__modules[${moduleId}] = function(__exports, __require) {\n${transformedCode}\n};`;

    const lineCount = wrapperCode.split('\n').length;

    return { wrapperCode, lineCount };
  }

  _transformModuleCode(mod, moduleId) {
    let code = mod.code;

    const importReplacements = [];

    for (const imp of mod.imports) {
      if (!imp.resolvedPath) continue;
      const depId = this.moduleIdMap.get(imp.resolvedPath);

      for (const spec of imp.specifiers) {
        if (spec.type === 'namespace') {
          importReplacements.push({
            original: spec.local,
            replacement: `__require(${depId})`,
            type: 'namespace',
          });
        } else if (spec.type === 'default') {
          importReplacements.push({
            original: spec.local,
            replacement: `__require(${depId}).default`,
            type: 'default',
          });
        } else if (spec.type === 'named') {
          importReplacements.push({
            original: spec.local,
            replacement: `__require(${depId}).${spec.imported}`,
            type: 'named',
            imported: spec.imported,
          });
        }
      }
    }

    code = this._removeImportDeclarations(code);

    code = this._transformExportDeclarations(code, mod);

    code = this._transformDynamicImports(code, mod);

    for (const rep of importReplacements) {
      const regex = new RegExp(`\\b${this._escapeRegex(rep.original)}\\b`, 'g');
      code = code.replace(regex, rep.replacement);
    }

    return code;
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _removeImportDeclarations(code) {
    try {
      const acorn = require('acorn');
      const ast = acorn.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
      });

      const importNodes = ast.body.filter(
        (node) => node.type === 'ImportDeclaration'
      );

      if (importNodes.length === 0) return code;

      let result = code;
      for (let i = importNodes.length - 1; i >= 0; i--) {
        const node = importNodes[i];
        result = result.slice(0, node.start) + result.slice(node.end);
      }

      return result;
    } catch {
      return code.replace(/^import\s+.*?['"].*?['"];?\s*$/gm, '');
    }
  }

  _transformExportDeclarations(code, mod) {
    try {
      const acorn = require('acorn');
      const ast = acorn.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
      });

      const replacements = [];

      for (const node of ast.body) {
        if (node.type === 'ExportDefaultDeclaration') {
          if (node.declaration.type === 'Identifier') {
            replacements.push({
              start: node.start,
              end: node.end,
              replacement: `Object.defineProperty(__exports, 'default', { enumerable: true, get: () => ${node.declaration.name} });`,
            });
          } else if (node.declaration.type === 'FunctionDeclaration') {
            const name = node.declaration.id ? node.declaration.id.name : '__default';
            const funcBody = code.slice(node.declaration.start, node.declaration.end);
            replacements.push({
              start: node.start,
              end: node.end,
              replacement: `${funcBody}\nObject.defineProperty(__exports, 'default', { enumerable: true, get: () => ${name} });`,
            });
          } else {
            const decl = code.slice(node.declaration.start, node.declaration.end);
            replacements.push({
              start: node.start,
              end: node.end,
              replacement: `__exports.default = ${decl};`,
            });
          }
        } else if (node.type === 'ExportNamedDeclaration') {
          if (node.declaration) {
            if (node.declaration.type === 'VariableDeclaration') {
              const varCode = code.slice(node.declaration.start, node.declaration.end);
              const names = node.declaration.declarations.map((d) => d.id.name);
              const exportDefs = names
                .map((n) => `Object.defineProperty(__exports, '${n}', { enumerable: true, get: () => ${n} });`)
                .join('\n');
              replacements.push({
                start: node.start,
                end: node.end,
                replacement: `${varCode}\n${exportDefs}`,
              });
            } else if (node.declaration.type === 'FunctionDeclaration') {
              const name = node.declaration.id.name;
              const funcCode = code.slice(node.declaration.start, node.declaration.end);
              replacements.push({
                start: node.start,
                end: node.end,
                replacement: `${funcCode}\nObject.defineProperty(__exports, '${name}', { enumerable: true, get: () => ${name} });`,
              });
            } else if (node.declaration.type === 'ClassDeclaration') {
              const name = node.declaration.id.name;
              const classCode = code.slice(node.declaration.start, node.declaration.end);
              replacements.push({
                start: node.start,
                end: node.end,
                replacement: `${classCode}\nObject.defineProperty(__exports, '${name}', { enumerable: true, get: () => ${name} });`,
              });
            }
          } else if (node.specifiers && node.specifiers.length > 0) {
            const specDefs = node.specifiers
              .map((s) => `Object.defineProperty(__exports, '${s.exported.name}', { enumerable: true, get: () => ${s.local.name} });`)
              .join('\n');
            replacements.push({
              start: node.start,
              end: node.end,
              replacement: specDefs,
            });
          }
        } else if (node.type === 'ExportAllDeclaration') {
          replacements.push({
            start: node.start,
            end: node.end,
            replacement: `Object.assign(__exports, __require(${this.moduleIdMap.get(node.source.value) || 0}));`,
          });
        }
      }

      if (replacements.length === 0) return code;

      replacements.sort((a, b) => b.start - a.start);
      let result = code;
      for (const r of replacements) {
        result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
      }

      return result;
    } catch {
      return code;
    }
  }

  _transformDynamicImports(code, mod) {
    return code.replace(
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      (match, importPath) => {
        const depInfo = mod.dynamicImports.find(
          (d) => d.source === importPath
        );
        if (depInfo && depInfo.resolvedPath) {
          const normalized = depInfo.resolvedPath.replace(/\\/g, '/');
          const chunkName = path.basename(
            normalized,
            path.extname(normalized)
          );
          const moduleId = this.moduleIdMap.get(depInfo.resolvedPath);
          return `__loadChunk('${chunkName}').then(() => __require(${moduleId}))`;
        }
        return match;
      }
    );
  }

  _findOriginalLine(mod, lineInTransformed) {
    return lineInTransformed;
  }

  _generateChunkImports(chunkName, chunk) {
    if (chunk.isEntry || chunk.isShared) return '';

    const imports = [];
    const sharedChunk = this.chunks.get('shared');
    if (sharedChunk && chunkName !== 'shared') {
      imports.push(`import './shared.js';`);
    }

    return imports.join('\n');
  }

  _generateRuntime(chunkName, chunk) {
    let runtime = '';
    runtime += 'var __chunks = {};\n';
    runtime += 'var __chunkPromises = {};\n\n';

    runtime += 'function __loadChunk(name) {\n';
    runtime += '  if (__chunks[name]) return Promise.resolve();\n';
    runtime += '  if (__chunkPromises[name]) return __chunkPromises[name];\n';
    runtime += '  __chunkPromises[name] = new Promise(function(resolve, reject) {\n';
    runtime += '    var script = document.createElement("script");\n';
    runtime += '    script.src = name + ".js";\n';
    runtime += '    script.onload = function() {\n';
    runtime += '      __chunks[name] = true;\n';
    runtime += '      resolve();\n';
    runtime += '    };\n';
    runtime += '    script.onerror = reject;\n';
    runtime += '    document.head.appendChild(script);\n';
    runtime += '  });\n';
    runtime += '  return __chunkPromises[name];\n';
    runtime += '}\n\n';

    runtime += 'var __modules = {};\n';
    runtime += 'var __moduleCache = {};\n\n';

    runtime += 'function __require(id) {\n';
    runtime += '  if (__moduleCache[id]) return __moduleCache[id];\n';
    runtime += '  var __exports = {};\n';
    runtime += '  __moduleCache[id] = __exports;\n';
    runtime += '  if (__modules[id]) {\n';
    runtime += '    __modules[id](__exports, __require);\n';
    runtime += '  }\n';
    runtime += '  return __exports;\n';
    runtime += '}\n\n';

    return runtime;
  }

  _generateEntryCall(chunkName, chunk, sortedModulePaths) {
    let output = '';
    if (chunk.isEntry) {
      for (const filePath of sortedModulePaths) {
        const id = this.moduleIdMap.get(filePath);
        const mod = this.graph.getModule(filePath);
        if (mod && mod.isEntry) {
          output += `__require(${id});\n`;
        }
      }
    }
    return output;
  }

  async writeBundles(results) {
    await fse.ensureDir(this.outputDir);

    for (const result of results) {
      const outputPath = path.join(this.outputDir, `${result.name}.js`);
      await fse.writeFile(outputPath, result.code, 'utf-8');

      if (result.sourcemap) {
        const mapPath = path.join(this.outputDir, `${result.name}.js.map`);
        await fse.writeFile(mapPath, JSON.stringify(result.sourcemap, null, 2), 'utf-8');
      }
    }

    return results;
  }
}

module.exports = Bundler;
