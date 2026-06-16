const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const acorn = require('acorn');
const { SourceMapGenerator } = require('./source-map');

const GLOBAL_NS = '__mini_pack';

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
    const dynamicEntryModules = new Set(this.graph.dynamicEntries);

    const mainModules = new Set();

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

    const topoOrder = this.graph.topologicalSort();
    const sortedModulePaths = topoOrder.filter((p) => chunk.modules.has(p));

    const moduleWrappers = [];
    let generatedLine = 1;

    const runtimeHeader = this._generateRuntimeHeader(chunkName, chunk);
    generatedLine += runtimeHeader.split('\n').length;

    for (const filePath of sortedModulePaths) {
      const mod = this.graph.getModule(filePath);
      if (!mod) continue;

      const moduleId = this.moduleIdMap.get(filePath);
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

      if (sourceMap) {
        sourceMap.addSourceContent(relativePath, this._getOriginalSource(filePath, mod));
      }

      const { wrapperCode, lineMappings } = this._wrapModule(
        mod, moduleId, filePath, relativePath
      );

      if (sourceMap && lineMappings) {
        const wrapperPrefix = `var ${GLOBAL_NS} = ${GLOBAL_NS} || {};\n${GLOBAL_NS}.modules = ${GLOBAL_NS}.modules || {};\n${GLOBAL_NS}.modules[${moduleId}] = function(__exports, __require) {\n`;
        const headerLineCount = wrapperPrefix.split('\n').length;

        for (const mapping of lineMappings) {
          sourceMap.addMapping({
            generated: { line: generatedLine + headerLineCount - 1 + mapping.generatedLine, column: mapping.generatedColumn || 0 },
            original: { line: mapping.originalLine, column: mapping.originalColumn || 0 },
            source: relativePath,
          });
        }
      }

      moduleWrappers.push(wrapperCode);
      generatedLine += wrapperCode.split('\n').length;
    }

    let output = runtimeHeader;

    for (const wrapper of moduleWrappers) {
      output += wrapper + '\n';
    }

    output += this._generateBootstrap(chunkName, chunk, sortedModulePaths);

    if (sourceMap) {
      output += '\n' + sourceMap.toComment();
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

  _getOriginalSource(filePath, mod) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return mod.code;
    }
  }

  _generateRuntimeHeader(chunkName, chunk) {
    if (chunk.isEntry) {
      let header = '';
      header += `var ${GLOBAL_NS} = ${GLOBAL_NS} || {};\n`;
      header += `${GLOBAL_NS}.modules = ${GLOBAL_NS}.modules || {};\n`;
      header += `${GLOBAL_NS}.cache = ${GLOBAL_NS}.cache || {};\n`;
      header += `${GLOBAL_NS}.chunks = ${GLOBAL_NS}.chunks || {};\n`;
      header += `${GLOBAL_NS}.chunkPromises = ${GLOBAL_NS}.chunkPromises || {};\n\n`;

      header += `${GLOBAL_NS}.loadChunk = ${GLOBAL_NS}.loadChunk || function(name) {\n`;
      header += `  if (${GLOBAL_NS}.chunks[name]) return Promise.resolve();\n`;
      header += `  if (${GLOBAL_NS}.chunkPromises[name]) return ${GLOBAL_NS}.chunkPromises[name];\n`;
      header += `  ${GLOBAL_NS}.chunkPromises[name] = new Promise(function(resolve, reject) {\n`;
      header += `    var script = document.createElement("script");\n`;
      header += `    script.src = name + ".js";\n`;
      header += `    script.onload = function() {\n`;
      header += `      ${GLOBAL_NS}.chunks[name] = true;\n`;
      header += `      resolve();\n`;
      header += `    };\n`;
      header += `    script.onerror = reject;\n`;
      header += `    document.head.appendChild(script);\n`;
      header += `  });\n`;
      header += `  return ${GLOBAL_NS}.chunkPromises[name];\n`;
      header += `};\n\n`;

      header += `var __require = ${GLOBAL_NS}.require = ${GLOBAL_NS}.require || function(id) {\n`;
      header += `  if (${GLOBAL_NS}.cache[id]) return ${GLOBAL_NS}.cache[id];\n`;
      header += `  var __exports = {};\n`;
      header += `  ${GLOBAL_NS}.cache[id] = __exports;\n`;
      header += `  if (${GLOBAL_NS}.modules[id]) {\n`;
      header += `    ${GLOBAL_NS}.modules[id](__exports, __require);\n`;
      header += `  }\n`;
      header += `  return __exports;\n`;
      header += `};\n\n`;

      return header;
    }

    let header = '';
    header += `var ${GLOBAL_NS} = ${GLOBAL_NS} || {};\n`;
    header += `${GLOBAL_NS}.modules = ${GLOBAL_NS}.modules || {};\n`;
    header += `${GLOBAL_NS}.cache = ${GLOBAL_NS}.cache || {};\n`;
    header += `var __require = ${GLOBAL_NS}.require || function(id) {\n`;
    header += `  if (${GLOBAL_NS}.cache[id]) return ${GLOBAL_NS}.cache[id];\n`;
    header += `  var __exports = {};\n`;
    header += `  ${GLOBAL_NS}.cache[id] = __exports;\n`;
    header += `  if (${GLOBAL_NS}.modules[id]) {\n`;
    header += `    ${GLOBAL_NS}.modules[id](__exports, __require);\n`;
    header += `  }\n`;
    header += `  return __exports;\n`;
    header += `};\n\n`;
    return header;
  }

  _wrapModule(mod, moduleId, filePath, relativePath) {
    const { transformedCode, lineMappings } = this._transformModuleCode(mod, moduleId);

    const wrapperCode = `var ${GLOBAL_NS} = ${GLOBAL_NS} || {};\n${GLOBAL_NS}.modules = ${GLOBAL_NS}.modules || {};\n${GLOBAL_NS}.modules[${moduleId}] = function(__exports, __require) {\n${transformedCode}\n};\n`;

    return { wrapperCode, lineMappings };
  }

  _transformModuleCode(mod, moduleId) {
    const originalCode = this._getOriginalSource(mod.filePath, mod);
    const lineMappings = [];

    let code = mod.code;

    const { code: afterImports, sideEffectRequires, removedImportLines } = this._removeImportDeclarations(code, mod);

    code = afterImports;

    const { code: afterExports } = this._transformExportDeclarations(code, mod);

    code = afterExports;

    code = this._transformDynamicImports(code, mod);

    const importReplacements = this._buildImportReplacements(mod);

    for (const rep of importReplacements) {
      const regex = new RegExp(`\\b${this._escapeRegex(rep.original)}\\b`, 'g');
      code = code.replace(regex, rep.replacement);
    }

    if (sideEffectRequires.length > 0) {
      code = sideEffectRequires.join('\n') + '\n' + code;
    }

    const originalCodeLines = originalCode.split('\n');
    const originalLineUsed = new Set();
    for (let i = 1; i <= originalCodeLines.length; i++) {
      originalLineUsed.add(i);
    }
    for (const removedLine of removedImportLines) {
      originalLineUsed.delete(removedLine);
    }

    const originalLineNumbers = Array.from(originalLineUsed).sort((a, b) => a - b);

    const transformedLines = code.split('\n');
    const sideEffectOffset = sideEffectRequires.length;

    for (let i = 0; i < transformedLines.length; i++) {
      const transformedLineNum = i + 1;
      let originalLine;

      if (transformedLineNum <= sideEffectOffset) {
        originalLine = 1;
      } else {
        const codeLineIdx = transformedLineNum - sideEffectOffset - 1;
        if (codeLineIdx < originalLineNumbers.length) {
          originalLine = originalLineNumbers[codeLineIdx];
        } else {
          originalLine = originalCodeLines.length;
        }
      }

      lineMappings.push({
        generatedLine: transformedLineNum,
        generatedColumn: 0,
        originalLine: originalLine,
        originalColumn: 0,
      });
    }

    return { transformedCode: code, lineMappings };
  }

  _removeImportDeclarations(code, mod) {
    const sideEffectRequires = [];
    const removedImportLines = [];

    try {
      const ast = acorn.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
      });

      const importNodes = ast.body.filter(
        (node) => node.type === 'ImportDeclaration'
      );

      if (importNodes.length === 0) return { code, sideEffectRequires, removedImportLines };

      for (const node of importNodes) {
        const source = node.source.value;
        const depInfo = mod.imports.find((imp) => imp.source === source);
        if (depInfo && depInfo.resolvedPath) {
          const depId = this.moduleIdMap.get(depInfo.resolvedPath);
          if (node.specifiers.length === 0) {
            sideEffectRequires.push(`__require(${depId});`);
          }
        }

        if (node.loc) {
          const startLine = node.loc.start.line;
          const endLine = node.loc.end.line;
          for (let l = startLine; l <= endLine; l++) {
            removedImportLines.push(l);
          }
        }
      }

      let result = code;
      for (let i = importNodes.length - 1; i >= 0; i--) {
        const node = importNodes[i];
        result = result.slice(0, node.start) + result.slice(node.end);
      }

      return { code: result, sideEffectRequires, removedImportLines };
    } catch {
      const lines = code.split('\n');
      const resultLines = [];
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (/^import\s+/.test(line.trim())) {
          removedImportLines.push(lineIdx + 1);
          const match = line.match(/^import\s+['"]([^'"]+)['"]/);
          if (match) {
            const depInfo = mod.imports.find((imp) => imp.source === match[1]);
            if (depInfo && depInfo.resolvedPath) {
              const depId = this.moduleIdMap.get(depInfo.resolvedPath);
              sideEffectRequires.push(`__require(${depId});`);
            }
          }
        } else {
          resultLines.push(line);
        }
      }
      return { code: resultLines.join('\n'), sideEffectRequires, removedImportLines };
    }
  }

  _transformExportDeclarations(code, mod) {
    try {
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
              replacement: `Object.defineProperty(__exports, 'default', { enumerable: true, get: function() { return ${node.declaration.name}; } });`,
              originalLoc: node.loc,
            });
          } else if (node.declaration.type === 'FunctionDeclaration') {
            const name = node.declaration.id ? node.declaration.id.name : '__default';
            const funcBody = code.slice(node.declaration.start, node.declaration.end);
            replacements.push({
              start: node.start,
              end: node.end,
              replacement: `${funcBody}\nObject.defineProperty(__exports, 'default', { enumerable: true, get: function() { return ${name}; } });`,
              originalLoc: node.loc,
            });
          } else {
            const decl = code.slice(node.declaration.start, node.declaration.end);
            replacements.push({
              start: node.start,
              end: node.end,
              replacement: `__exports.default = ${decl};`,
              originalLoc: node.loc,
            });
          }
        } else if (node.type === 'ExportNamedDeclaration') {
          if (node.declaration) {
            if (node.declaration.type === 'VariableDeclaration') {
              const varCode = code.slice(node.declaration.start, node.declaration.end);
              const names = node.declaration.declarations.map((d) => d.id.name);
              const exportDefs = names
                .map((n) => `Object.defineProperty(__exports, '${n}', { enumerable: true, get: function() { return ${n}; } });`)
                .join('\n');
              replacements.push({
                start: node.start,
                end: node.end,
                replacement: `${varCode}\n${exportDefs}`,
                originalLoc: node.loc,
              });
            } else if (node.declaration.type === 'FunctionDeclaration') {
              const name = node.declaration.id.name;
              const funcCode = code.slice(node.declaration.start, node.declaration.end);
              replacements.push({
                start: node.start,
                end: node.end,
                replacement: `${funcCode}\nObject.defineProperty(__exports, '${name}', { enumerable: true, get: function() { return ${name}; } });`,
                originalLoc: node.loc,
              });
            } else if (node.declaration.type === 'ClassDeclaration') {
              const name = node.declaration.id.name;
              const classCode = code.slice(node.declaration.start, node.declaration.end);
              replacements.push({
                start: node.start,
                end: node.end,
                replacement: `${classCode}\nObject.defineProperty(__exports, '${name}', { enumerable: true, get: function() { return ${name}; } });`,
                originalLoc: node.loc,
              });
            }
          } else if (node.specifiers && node.specifiers.length > 0) {
            const specDefs = node.specifiers
              .map((s) => `Object.defineProperty(__exports, '${s.exported.name}', { enumerable: true, get: function() { return ${s.local.name}; } });`)
              .join('\n');
            replacements.push({
              start: node.start,
              end: node.end,
              replacement: specDefs,
              originalLoc: node.loc,
            });
          }
        } else if (node.type === 'ExportAllDeclaration') {
          replacements.push({
            start: node.start,
            end: node.end,
            replacement: `Object.assign(__exports, __require(${this.moduleIdMap.get(node.source.value) || 0}));`,
            originalLoc: node.loc,
          });
        }
      }

      if (replacements.length === 0) return { code, lineOffsetAfterExports: 0 };

      replacements.sort((a, b) => b.start - a.start);
      let result = code;
      for (const r of replacements) {
        result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
      }

      return { code: result, lineOffsetAfterExports: 0 };
    } catch {
      return { code, lineOffsetAfterExports: 0 };
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
          return `${GLOBAL_NS}.loadChunk('${chunkName}').then(function() { return __require(${moduleId}); })`;
        }
        return match;
      }
    );
  }

  _buildImportReplacements(mod) {
    const importReplacements = [];
    for (const imp of mod.imports) {
      if (!imp.resolvedPath) continue;
      const depId = this.moduleIdMap.get(imp.resolvedPath);

      for (const spec of imp.specifiers) {
        if (spec.type === 'namespace') {
          importReplacements.push({
            original: spec.local,
            replacement: `__require(${depId})`,
          });
        } else if (spec.type === 'default') {
          importReplacements.push({
            original: spec.local,
            replacement: `__require(${depId}).default`,
          });
        } else if (spec.type === 'named') {
          importReplacements.push({
            original: spec.local,
            replacement: `__require(${depId}).${spec.imported}`,
          });
        }
      }
    }
    return importReplacements;
  }

  _generateBootstrap(chunkName, chunk, sortedModulePaths) {
    let output = '\n';
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

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
