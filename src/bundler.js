const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const acorn = require('acorn');
const { SourceMapGenerator, SourceMapConsumer } = require('./source-map');

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
      dependencies: [],
    });

    const sharedModules = new Set();
    const chunkDependencies = {};

    for (const dynEntry of this.graph.dynamicEntries) {
      const chunkMods = new Set();
      const visited = new Set();
      const chunkDeps = [];

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
      chunkDependencies[chunkName] = chunkDeps;
      this.chunks.set(chunkName, {
        name: chunkName,
        modules: chunkMods,
        isEntry: false,
        entryModule: dynEntry,
        dependencies: chunkDeps,
      });
    }

    if (sharedModules.size > 0) {
      this.chunks.set('shared', {
        name: 'shared',
        modules: sharedModules,
        isEntry: false,
        isShared: true,
        dependencies: [],
      });

      for (const [chunkName, chunk] of this.chunks) {
        if (chunk.isShared) continue;
        const newModules = new Set();
        for (const mod of chunk.modules) {
          if (!sharedModules.has(mod)) {
            newModules.add(mod);
          }
        }
        chunk.modules = newModules;
      }

      for (const [chunkName, chunk] of this.chunks) {
        if (chunk.isShared) continue;
        const needsShared = [...chunk.modules].some((modPath) => {
          const mod = this.graph.getModule(modPath);
          if (!mod) return false;
          return [...mod.dependencies].some((dep) => sharedModules.has(dep));
        });
        if (needsShared && !chunk.dependencies.includes('shared')) {
          chunk.dependencies.push('shared');
        }
      }
    }

    const manifest = {
      chunks: {},
      moduleIdMap: {},
    };

    for (const [chunkName, chunk] of this.chunks) {
      const chunkInfo = {
        name: chunkName,
        isEntry: !!chunk.isEntry,
        isShared: !!chunk.isShared,
        dependencies: chunk.dependencies || [],
        modules: [...chunk.modules].map((p) => path.relative(process.cwd(), p).replace(/\\/g, '/')),
      };
      if (chunk.entryModule) {
        const rel = path.relative(process.cwd(), chunk.entryModule).replace(/\\/g, '/');
        chunkInfo.entryModule = rel;
        chunkInfo.entryModuleId = this.moduleIdMap.get(chunk.entryModule);
      } else if (chunk.isEntry) {
        for (const entry of this.graph.entries) {
          if (this.graph.getModule(entry) && chunk.modules.has(entry)) {
            const rel = path.relative(process.cwd(), entry).replace(/\\/g, '/');
            chunkInfo.entryModule = rel;
            chunkInfo.entryModuleId = this.moduleIdMap.get(entry);
            break;
          }
        }
      }
      manifest.chunks[chunkName] = chunkInfo;
    }

    for (const [filePath, id] of this.moduleIdMap) {
      manifest.moduleIdMap[path.relative(process.cwd(), filePath).replace(/\\/g, '/')] = id;
    }

    this.manifest = manifest;
  }

  _generateChunks() {
    const results = [];

    for (const [chunkName, chunk] of this.chunks) {
      const result = this._generateChunk(chunkName, chunk);
      results.push(result);
    }

    if (this.manifest) {
      results.push({
        name: 'manifest',
        isManifest: true,
        manifest: this.manifest,
      });
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
    const runtimeLines = runtimeHeader.split('\n').length;
    if (runtimeLines > 1) generatedLine += (runtimeLines - 1);

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
      const wrapperLines = wrapperCode.split('\n').length;

      if (sourceMap && lineMappings) {
        const wrapperPrefix = `var ${GLOBAL_NS} = ${GLOBAL_NS} || {};\n${GLOBAL_NS}.modules = ${GLOBAL_NS}.modules || {};\n${GLOBAL_NS}.modules[${moduleId}] = function(__exports, __require) {\n`;
        const headerLineCount = wrapperPrefix.split('\n').length;

        for (const mapping of lineMappings) {
          const gl = generatedLine + headerLineCount - 2 + mapping.generatedLine;
          sourceMap.addMapping({
            generated: { line: gl, column: mapping.generatedColumn || 0 },
            original: { line: mapping.originalLine, column: mapping.originalColumn || 0 },
            source: relativePath,
          });
        }
      }

      moduleWrappers.push(wrapperCode);
      if (wrapperLines > 1) generatedLine += (wrapperLines - 1);
      generatedLine += 1;
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
    const manifestJson = this.manifest ? JSON.stringify(this.manifest) : 'null';

    if (chunk.isEntry) {
      let header = '';
      header += `var ${GLOBAL_NS} = ${GLOBAL_NS} || {};\n`;
      header += `${GLOBAL_NS}.modules = ${GLOBAL_NS}.modules || {};\n`;
      header += `${GLOBAL_NS}.cache = ${GLOBAL_NS}.cache || {};\n`;
      header += `${GLOBAL_NS}.chunks = ${GLOBAL_NS}.chunks || {};\n`;
      header += `${GLOBAL_NS}.chunkPromises = ${GLOBAL_NS}.chunkPromises || {};\n`;
      header += `${GLOBAL_NS}.manifest = ${GLOBAL_NS}.manifest || ${manifestJson};\n\n`;

      header += `${GLOBAL_NS}.loadChunk = ${GLOBAL_NS}.loadChunk || function(name) {\n`;
      header += `  if (${GLOBAL_NS}.chunks[name]) return Promise.resolve();\n`;
      header += `  if (${GLOBAL_NS}.chunkPromises[name]) return ${GLOBAL_NS}.chunkPromises[name];\n`;
      header += `  var chunkInfo = (${GLOBAL_NS}.manifest && ${GLOBAL_NS}.manifest.chunks) ? ${GLOBAL_NS}.manifest.chunks[name] : null;\n`;
      header += `  var deps = chunkInfo ? (chunkInfo.dependencies || []) : [];\n`;
      header += `  var loadSelf = function() {\n`;
      header += `    return new Promise(function(resolve, reject) {\n`;
      header += `      var script = document.createElement("script");\n`;
      header += `      script.src = name + ".js";\n`;
      header += `      script.onload = function() {\n`;
      header += `        ${GLOBAL_NS}.chunks[name] = true;\n`;
      header += `        resolve();\n`;
      header += `      };\n`;
      header += `      script.onerror = reject;\n`;
      header += `      document.head.appendChild(script);\n`;
      header += `    });\n`;
      header += `  };\n`;
      header += `  var depPromises = deps.map(function(d) { return ${GLOBAL_NS}.loadChunk(d); });\n`;
      header += `  ${GLOBAL_NS}.chunkPromises[name] = Promise.all(depPromises).then(loadSelf);\n`;
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
        let sliceEnd = node.end;
        while (sliceEnd < result.length && (result[sliceEnd] === '\r' || result[sliceEnd] === '\n' || result[sliceEnd] === ' ' || result[sliceEnd] === '\t')) {
          const c = result[sliceEnd];
          sliceEnd++;
          if (c === '\n') break;
        }
        result = result.slice(0, node.start) + result.slice(sliceEnd);
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

    const written = [];

    for (const result of results) {
      if (result.isManifest) {
        const manifestPath = path.join(this.outputDir, 'manifest.json');
        await fse.writeFile(manifestPath, JSON.stringify(result.manifest, null, 2), 'utf-8');
        written.push({ ...result, outputPath: manifestPath });
        continue;
      }

      const outputPath = path.join(this.outputDir, `${result.name}.js`);
      await fse.writeFile(outputPath, result.code, 'utf-8');

      if (result.sourcemap) {
        const mapPath = path.join(this.outputDir, `${result.name}.js.map`);
        await fse.writeFile(mapPath, JSON.stringify(result.sourcemap, null, 2), 'utf-8');
      }

      written.push({ ...result, outputPath });
    }

    const entryResult = results.find((r) => r.isEntry);
    if (entryResult) {
      const htmlPath = await this._writeDemoPage(results);
      if (htmlPath) {
        written.push({
          name: 'index',
          isHtml: true,
          outputPath: htmlPath,
        });
      }
    }

    return written;
  }

  _writeDemoPage(results) {
    const manifest = results.find((r) => r.isManifest)?.manifest || this.manifest || null;
    const manifestJson = manifest ? JSON.stringify(manifest, null, 2) : 'null';

    const chunkInfos = results
      .filter((r) => !r.isManifest && !r.isHtml)
      .map((r) => {
        const m = (manifest && manifest.chunks && manifest.chunks[r.name]) || {};
        const sizeBytes = Buffer.byteLength(r.code, 'utf-8');
        return {
          name: r.name,
          sizeBytes,
          sizeKB: (sizeBytes / 1024).toFixed(2),
          isEntry: !!r.isEntry,
          isShared: !!r.isShared,
          moduleCount: (m.modules || []).length,
          modules: m.modules || [],
          dependencies: m.dependencies || [],
          entryModule: m.entryModule || null,
          entryModuleId: m.entryModuleId != null ? m.entryModuleId : null,
        };
      });

    const smLookup = {};
    const smData = {};
    for (const r of results) {
      if (r.isManifest || r.isHtml) continue;
      if (!r.sourcemap) continue;
      try {
        const consumer = new SourceMapConsumer(r.sourcemap);
        const table = {};
        const lines = r.code.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const gl = i + 1;
          const pos = consumer.originalPositionFor({ line: gl, column: 0 });
          if (pos.source != null) {
            table[gl] = {
              source: pos.source,
              line: pos.line,
              column: pos.column,
              name: pos.name || null,
            };
          }
        }
        smLookup[r.name] = table;
        smData[r.name] = {
          sources: r.sourcemap.sources || [],
          sourcesContent: r.sourcemap.sourcesContent || [],
        };
      } catch (e) {}
    }

    const smLookupJson = JSON.stringify(smLookup);
    const smDataJson = JSON.stringify(smData);

    const chunkListHtml = chunkInfos
      .map((c) => {
        const typeBadge = c.isEntry ? '📦 Entry' : c.isShared ? '🔗 Shared' : '🧩 Async';
        const typeClass = c.isEntry ? 'chunk-type-entry' : c.isShared ? 'chunk-type-shared' : 'chunk-type-async';
        const depsStr = c.dependencies.length > 0
          ? `<div class="chunk-sub">Dependencies: <strong>${c.dependencies.join(', ')}</strong></div>`
          : '';
        const entryStr = c.entryModule
          ? `<div class="chunk-sub">Entry: <code>${c.entryModule}</code> (id ${c.entryModuleId})</div>`
          : '';
        const modsStr = c.modules.length > 0
          ? `<div class="chunk-sub">Modules (${c.moduleCount}): ${c.modules.map((m) => `<span class="tag">${m}</span>`).join(' ')}</div>`
          : '';
        return `
<li class="chunk-card ${typeClass}" id="chunk-card-${c.name}" data-chunk="${c.name}">
  <div class="chunk-header">
    <span class="chunk-name">${c.name}.js</span>
    <span class="chunk-size">${c.sizeKB} KB</span>
  </div>
  <div class="chunk-badge">${typeBadge}</div>
  ${depsStr}
  ${entryStr}
  ${modsStr}
  <div class="chunk-status" id="chunk-status-${c.name}">
    <span class="status-dot status-pending"></span>
    <span class="status-text">Pending</span>
  </div>
</li>`;
      })
      .join('\n');

    const chunkNames = chunkInfos.map((c) => c.name);
    const chunkNamesJson = JSON.stringify(chunkNames);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>mini-pack Browser Demo</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 16px; background: #f0f2f5; color: #333; }
  .layout { max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: 340px 1fr; gap: 16px; }
  h1 { margin: 0 0 4px 0; font-size: 20px; color: #1a1a2e; }
  h2 { margin: 0 0 12px 0; font-size: 14px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e0e0e0; padding-bottom: 6px; }
  .panel { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .header-panel { grid-column: 1 / -1; }
  .sub { color: #888; font-size: 13px; margin-bottom: 8px; }

  /* Chunk graph */
  .chunk-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
  .chunk-card { position: relative; border: 1px solid #e0e0e0; border-radius: 6px; padding: 10px 12px; background: #fafafa; transition: all 0.2s; }
  .chunk-card.chunk-type-entry { border-left: 4px solid #4a90d9; }
  .chunk-card.chunk-type-shared { border-left: 4px solid #f5a623; }
  .chunk-card.chunk-type-async { border-left: 4px solid #7ed321; }
  .chunk-card.loaded { background: #e8f5e9; border-color: #81c784; }
  .chunk-card.loading { background: #fff3e0; border-color: #ffb74d; }
  .chunk-header { display: flex; justify-content: space-between; align-items: center; }
  .chunk-name { font-weight: 600; font-size: 14px; }
  .chunk-size { color: #888; font-size: 12px; font-family: monospace; }
  .chunk-badge { position: absolute; top: 10px; right: 12px; font-size: 10px; padding: 2px 6px; border-radius: 10px; background: #e0e0e0; color: #555; text-transform: uppercase; }
  .chunk-card.chunk-type-entry .chunk-badge { background: #bbdefb; color: #1565c0; }
  .chunk-card.chunk-type-shared .chunk-badge { background: #ffe0b2; color: #e65100; }
  .chunk-card.chunk-type-async .chunk-badge { background: #dcedc8; color: #33691e; }
  .chunk-sub { font-size: 11px; color: #666; margin-top: 4px; }
  .chunk-sub code { background: #eee; padding: 1px 4px; border-radius: 3px; font-size: 10px; }
  .chunk-sub .tag { display: inline-block; background: #e8e8e8; padding: 1px 6px; border-radius: 10px; margin: 1px 2px; font-size: 10px; }
  .chunk-status { margin-top: 8px; display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .status-dot.status-pending { background: #bdbdbd; }
  .status-dot.status-loading { background: #ff9800; animation: pulse 1s infinite; }
  .status-dot.status-loaded { background: #4caf50; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .status-text { color: #666; }

  /* Controls */
  .controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  button { padding: 8px 14px; font-size: 13px; border: none; border-radius: 4px; cursor: pointer; background: #4a90d9; color: white; transition: background 0.2s; font-weight: 500; }
  button:hover { background: #357abd; }
  button.secondary { background: #78909c; }
  button.secondary:hover { background: #546e7a; }
  button.success { background: #4caf50; }
  button.success:hover { background: #388e3c; }
  button:disabled { background: #bdbdbd; cursor: not-allowed; }
  .status-bar { padding: 6px 12px; border-radius: 4px; background: #e8f5e9; color: #2e7d32; display: inline-block; font-size: 12px; margin-bottom: 8px; }
  .status-bar.error { background: #ffebee; color: #c62828; }

  /* Log panel */
  .log-panel { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 6px; font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; max-height: 380px; overflow-y: auto; line-height: 1.5; }
  .log-entry { padding: 2px 0; border-bottom: 1px solid #2a2a2a; white-space: pre-wrap; word-break: break-all; }
  .log-entry:last-child { border-bottom: none; }
  .log-event { padding-left: 24px; position: relative; }
  .log-event::before {
    content: attr(data-icon);
    position: absolute;
    left: 0;
    top: 0;
    width: 20px;
    text-align: center;
  }
  .log-cat-boot { color: #ce93d8; }
  .log-cat-shared { color: #ffb74d; }
  .log-cat-dynamic { color: #81d4fa; }
  .log-cat-cache { color: #a5d6a7; }
  .log-cat-log { color: #d4d4d4; }
  .log-cat-error { color: #ef9a9a; }
  .log-ts { color: #666; margin-right: 8px; font-size: 11px; }
  .log-detail { color: #888; font-size: 11px; margin-left: 28px; margin-top: 2px; }

  /* Source map panel */
  .sm-panel { margin-top: 16px; }
  .sm-controls { display: flex; gap: 6px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
  .sm-controls select, .sm-controls input {
    padding: 6px 8px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; background: #fff;
  }
  .sm-controls select { min-width: 120px; }
  .sm-controls input[type=number] { width: 80px; }
  .sm-result { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 4px; padding: 10px; font-family: monospace; font-size: 12px; }
  .sm-result .sm-hit { color: #2e7d32; font-weight: bold; }
  .sm-result .sm-miss { color: #c62828; }
  .sm-result .sm-source { color: #1565c0; }
  .sm-result .sm-line { color: #6a1b9a; }
  .sm-context { background: #2d2d2d; color: #d4d4d4; padding: 8px; border-radius: 4px; margin-top: 8px; max-height: 200px; overflow-y: auto; font-size: 11px; }
  .sm-context .sm-ctx-line { padding: 1px 4px; }
  .sm-context .sm-ctx-target { background: #ffeb3b; color: #000; font-weight: bold; }

  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="layout">
  <div class="panel header-panel">
    <h1>🗜️ mini-pack Browser Demo</h1>
    <div class="sub">Side-effect modules · Dynamic chunk loading · Shared dependencies · Source maps</div>
  </div>

  <div class="panel">
    <h2>📦 Chunk Dependency Graph</h2>
    <ul class="chunk-list" id="chunk-list">
      ${chunkListHtml}
    </ul>
    <div class="sub" style="margin-top: 12px;">
      <strong>Legend:</strong>
      <span style="color:#1565c0">■ Entry</span> ·
      <span style="color:#e65100">■ Shared</span> ·
      <span style="color:#33691e">■ Async</span>
    </div>
  </div>

  <div>
    <div class="panel">
      <h2>▶️ Runtime Controls</h2>
      <div class="controls">
        <button id="btn-dashboard" class="success">Load Dashboard</button>
        <button id="btn-dashboard-again" class="secondary">Load Again (Cache)</button>
        <button id="btn-check-cache" class="secondary">Inspect Cache</button>
        <button id="btn-clear-log" class="secondary">Clear Log</button>
      </div>
      <div id="status-bar" class="status-bar">Initializing...</div>
    </div>

    <div class="panel" style="margin-top: 16px;">
      <h2>📋 Event Log</h2>
      <div class="log-panel" id="log-panel"></div>
    </div>

    <div class="panel sm-panel">
      <h2>🔍 Source Map Inspector</h2>
      <div class="sm-controls">
        <select id="sm-chunk">
          ${chunkInfos.map((c) => `<option value="${c.name}">${c.name}.js</option>`).join('\n')}
        </select>
        <span>Line:</span>
        <input type="number" id="sm-line" min="1" value="1" />
        <button id="sm-query">Query</button>
      </div>
      <div class="sm-result" id="sm-result">Select a chunk and line, then click Query.</div>
      <div class="sm-context" id="sm-context" style="display:none;"></div>
    </div>
  </div>
</div>

<script>
(function() {
  var __MANIFEST__ = ${manifestJson};
  var __SM_LOOKUP__ = ${smLookupJson};
  var __SM_DATA__ = ${smDataJson};
  var __CHUNK_NAMES__ = ${chunkNamesJson};

  if (typeof window !== 'undefined') {
    window.__mini_pack = window.__mini_pack || {};
    window.__mini_pack.manifest = __MANIFEST__;
  }
})();
</script>
<script>
(function() {
  var panel = document.getElementById('log-panel');
  var statusBar = document.getElementById('status-bar');

  var originalLog = console.log;
  var originalWarn = console.warn;
  var originalError = console.error;
  var originalInfo = console.info;

  function ts() {
    var d = new Date();
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function addEvent(category, icon, message, detail) {
    var entry = document.createElement('div');
    entry.className = 'log-entry log-event log-cat-' + category;
    entry.setAttribute('data-icon', icon);
    var html = '<span class="log-ts">[' + ts() + ']</span>' + String(message);
    if (detail) html += '<div class="log-detail">' + detail + '</div>';
    entry.innerHTML = html;
    panel.appendChild(entry);
    panel.scrollTop = panel.scrollHeight;
  }

  function addLog(level, args) {
    var parts = Array.prototype.slice.call(args).map(function(a) {
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }
      return String(a);
    });
    var cat = 'log';
    if (level === 'error') cat = 'error';
    else if (level === 'warn') cat = 'log';
    else if (level === 'info') cat = 'log';
    addEvent(cat, '📝', parts.join(' '));
  }

  console.log = function() { originalLog.apply(console, arguments); addLog('log', arguments); };
  console.info = function() { originalInfo.apply(console, arguments); addLog('info', arguments); };
  console.warn = function() { originalWarn.apply(console, arguments); addLog('warn', arguments); };
  console.error = function() { originalError.apply(console, arguments); addLog('error', arguments); };

  window.addEventListener('error', function(e) {
    addEvent('error', '❌', 'Window error: ' + e.message, e.filename + ':' + e.lineno);
    if (statusBar) { statusBar.textContent = 'Error: ' + e.message; statusBar.className = 'status-bar error'; }
  });

  window.addEventListener('unhandledrejection', function(e) {
    addEvent('error', '❌', 'Unhandled promise: ' + String(e.reason));
    if (statusBar) { statusBar.textContent = 'Promise error: ' + String(e.reason); statusBar.className = 'status-bar error'; }
  });

  function setChunkStatus(name, status, text) {
    var card = document.getElementById('chunk-card-' + name);
    if (!card) return;
    card.classList.remove('loaded', 'loading');
    if (status === 'loaded') card.classList.add('loaded');
    else if (status === 'loading') card.classList.add('loading');
    var statusEl = document.getElementById('chunk-status-' + name);
    if (!statusEl) return;
    var dot = statusEl.querySelector('.status-dot');
    var txt = statusEl.querySelector('.status-text');
    if (dot) { dot.className = 'status-dot status-' + status; }
    if (txt) { txt.textContent = text || (status.charAt(0).toUpperCase() + status.slice(1)); }
  }

  function topoSortChunks(manifest) {
    if (!manifest || !manifest.chunks) return [];
    var inDegree = {};
    var graph = {};
    var names = Object.keys(manifest.chunks);
    names.forEach(function(n) { inDegree[n] = 0; graph[n] = []; });
    names.forEach(function(n) {
      var deps = manifest.chunks[n].dependencies || [];
      deps.forEach(function(d) {
        if (graph[d]) { graph[d].push(n); inDegree[n] = (inDegree[n] || 0) + 1; }
      });
    });
    var queue = names.filter(function(n) { return inDegree[n] === 0; });
    var result = [];
    while (queue.length > 0) {
      var cur = queue.shift();
      result.push(cur);
      (graph[cur] || []).forEach(function(next) {
        inDegree[next]--;
        if (inDegree[next] === 0) queue.push(next);
      });
    }
    if (result.length !== names.length) {
      addEvent('error', '⚠️', 'Chunk dependency cycle detected', 'Falling back to natural order');
      return names;
    }
    return result;
  }

  function loadScript(name) {
    return new Promise(function(resolve, reject) {
      var ns = window.__mini_pack || {};
      if (ns.chunks && ns.chunks[name]) { resolve(); return; }
      if (ns.chunkPromises && ns.chunkPromises[name]) { ns.chunkPromises[name].then(resolve, reject); return; }
      setChunkStatus(name, 'loading', 'Loading...');
      addEvent('dynamic', '⬇️', 'Loading chunk: ' + name + '.js');
      var script = document.createElement('script');
      script.src = name + '.js';
      script.onload = function() {
        if (window.__mini_pack) {
          window.__mini_pack.chunks = window.__mini_pack.chunks || {};
          window.__mini_pack.chunks[name] = true;
        }
        setChunkStatus(name, 'loaded', 'Loaded');
        addEvent('dynamic', '✅', 'Chunk loaded: ' + name + '.js');
        resolve();
      };
      script.onerror = function() {
        setChunkStatus(name, 'error', 'Failed');
        addEvent('error', '❌', 'Failed to load ' + name + '.js');
        reject(new Error('Failed to load ' + name + '.js'));
      };
      document.head.appendChild(script);
    });
  }

  function loadChunkWithDeps(name) {
    var ns = window.__mini_pack;
    if (ns && ns.loadChunk) {
      setChunkStatus(name, 'loading', 'Loading...');
      var info = (ns.manifest && ns.manifest.chunks) ? ns.manifest.chunks[name] : null;
      var deps = info ? (info.dependencies || []) : [];
      if (deps.length > 0) addEvent('shared', '🔗', 'Resolving dependencies for ' + name + ': [' + deps.join(', ') + ']');
      return ns.loadChunk(name).then(function() {
        setChunkStatus(name, 'loaded', 'Loaded');
        return null;
      });
    }
    return loadScript(name);
  }

  function bootstrapEntry() {
    var ns = window.__mini_pack;
    if (!ns || !ns.require || !ns.manifest) return null;
    var entryName = null, entryId = null;
    for (var n in ns.manifest.chunks) {
      if (ns.manifest.chunks.hasOwnProperty(n) && ns.manifest.chunks[n].isEntry) {
        entryName = n;
        entryId = ns.manifest.chunks[n].entryModuleId;
        break;
      }
    }
    if (entryId == null) return null;
    addEvent('boot', '📦', 'Bootstrapping entry module: ' + entryName + ' (id ' + entryId + ')');
    try {
      var exp = ns.require(entryId);
      if (typeof exp === 'object' && exp) {
        for (var k in exp) {
          if (exp.hasOwnProperty(k) && typeof exp[k] === 'function') {
            window[k] = exp[k];
          }
        }
      }
      addEvent('boot', '✅', 'Entry bootstrap complete');
      return exp;
    } catch (e) {
      addEvent('error', '❌', 'Entry bootstrap failed', e.message || e);
      throw e;
    }
  }

  function loadDashboard(label) {
    var ns = window.__mini_pack;
    if (!ns) { addEvent('error', '❌', '__mini_pack runtime not initialized'); return Promise.reject(); }
    var chunkName = 'dashboard';
    var info = ns.manifest && ns.manifest.chunks ? ns.manifest.chunks[chunkName] : null;
    if (!info) {
      addEvent('error', '❌', 'Manifest has no info for chunk: ' + chunkName);
      return Promise.reject();
    }
    var entryId = info.entryModuleId;

    var isCached = ns.chunks && ns.chunks[chunkName];
    if (isCached) {
      addEvent('cache', '💾', 'Chunk cache hit: ' + chunkName + ' (already loaded)');
    } else {
      addEvent('dynamic', '⚡', 'Dynamic load: ' + chunkName + ' (' + label + ')');
    }

    return loadChunkWithDeps(chunkName).then(function() {
      addEvent('dynamic', '✅', chunkName + ' chunk ready, requiring entry module ' + entryId);
      if (!ns.require) { addEvent('error', '❌', '__mini_pack.require missing'); return; }
      var dashExports = ns.require(entryId);
      if (dashExports && typeof dashExports.init === 'function') {
        addEvent('dynamic', '▶️', 'Calling dashboard.init()...');
        dashExports.init();
      }
      if (statusBar) {
        statusBar.textContent = 'Dashboard loaded (' + label + ')';
        statusBar.className = 'status-bar';
      }
      return dashExports;
    }).catch(function(err) {
      addEvent('error', '❌', 'Dashboard load failed', err.message || err);
      if (statusBar) {
        statusBar.textContent = 'Failed: ' + (err.message || err);
        statusBar.className = 'status-bar error';
      }
      throw err;
    });
  }

  var btn1 = document.getElementById('btn-dashboard');
  var btn2 = document.getElementById('btn-dashboard-again');
  var btn3 = document.getElementById('btn-check-cache');
  var btn4 = document.getElementById('btn-clear-log');

  if (btn1) btn1.addEventListener('click', function() { loadDashboard('first'); });
  if (btn2) btn2.addEventListener('click', function() { loadDashboard('cached'); });
  if (btn3) btn3.addEventListener('click', function() {
    var ns = window.__mini_pack || {};
    addEvent('cache', '💾', 'Module cache inspection');
    addEvent('cache', '  ', 'Chunks loaded: ' + (Object.keys(ns.chunks || {}).join(', ') || '(none)'));
    var cacheKeys = Object.keys(ns.cache || {});
    addEvent('cache', '  ', 'Module cache size: ' + cacheKeys.length + ' (ids: ' + cacheKeys.join(', ') + ')');
    if (ns.cache) {
      for (var id in ns.cache) {
        if (ns.cache.hasOwnProperty(id)) {
          var exp = ns.cache[id];
          var keys = Object.keys(exp);
          addEvent('cache', '  ', '  id=' + id + ' → {' + keys.join(', ') + '}');
        }
      }
    }
    if (statusBar) {
      statusBar.textContent = 'Cache inspected — see event log';
      statusBar.className = 'status-bar';
    }
  });
  if (btn4) btn4.addEventListener('click', function() { panel.innerHTML = ''; });

  // Source map inspector
  var smChunk = document.getElementById('sm-chunk');
  var smLine = document.getElementById('sm-line');
  var smQuery = document.getElementById('sm-query');
  var smResult = document.getElementById('sm-result');
  var smContext = document.getElementById('sm-context');

  function querySourceMap(chunkName, lineNum) {
    var lookup = __SM_LOOKUP__[chunkName];
    var data = __SM_DATA__[chunkName];
    if (!lookup || !data) {
      smResult.innerHTML = '<span class="sm-miss">No source map for ' + chunkName + '</span>';
      smContext.style.display = 'none';
      return;
    }
    var hit = lookup[lineNum];
    if (!hit) {
      var prev = null;
      var sortedKeys = Object.keys(lookup).map(Number).sort(function(a,b){return a-b;});
      for (var i = 0; i < sortedKeys.length; i++) {
        if (sortedKeys[i] < lineNum) prev = sortedKeys[i];
        else break;
      }
      if (prev != null) {
        var prevHit = lookup[prev];
        smResult.innerHTML = '<span class="sm-miss">No exact mapping at line ' + lineNum + '</span><br>' +
          '<span style="color:#888">Nearest mapped line: ' + prev + ' → </span>' +
          '<span class="sm-source">' + prevHit.source + '</span>:' +
          '<span class="sm-line">' + prevHit.line + '</span>';
        hit = prevHit;
        lineNum = prev;
      } else {
        smResult.innerHTML = '<span class="sm-miss">No mapping found for line ' + lineNum + '</span> (runtime / wrapper code)';
        smContext.style.display = 'none';
        return;
      }
    } else {
      smResult.innerHTML = '<span class="sm-hit">✓ Mapped</span> — ' +
        '<span class="sm-source">' + hit.source + '</span> line <span class="sm-line">' + hit.line + '</span>' +
        (hit.column != null ? ', col ' + hit.column : '') +
        (hit.name ? ' <span style="color:#888">(symbol: ' + hit.name + ')</span>' : '');
    }

    var sources = data.sources || [];
    var sourcesContent = data.sourcesContent || [];
    var srcIdx = sources.indexOf(hit.source);

    if (srcIdx >= 0 && srcIdx < sourcesContent.length && sourcesContent[srcIdx]) {
      var lines = sourcesContent[srcIdx].split('\n');
      var target = hit.line;
      var html = '';
      var start = Math.max(0, target - 4);
      var end = Math.min(lines.length, target + 3);
      for (var l = start; l < end; l++) {
        var ln = l + 1;
        var cls = 'sm-ctx-line' + (ln === target ? ' sm-ctx-target' : '');
        var lineStr = String(ln).padStart(3, ' ');
        var content = lines[l] || '';
        content = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html += '<div class="' + cls + '">  ' + lineStr + ' | ' + content + '</div>';
      }
      smContext.innerHTML = '<div style="color:#888;margin-bottom:4px;">Source context from ' + hit.source + '</div>' + html;
      smContext.style.display = 'block';
    } else {
      smContext.style.display = 'none';
    }
  }

  if (smQuery) smQuery.addEventListener('click', function() {
    querySourceMap(smChunk.value, parseInt(smLine.value, 10));
  });
  if (smLine) smLine.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') querySourceMap(smChunk.value, parseInt(smLine.value, 10));
  });

  // === Bootstrap ===
  addEvent('boot', '🚀', 'Mini-pack demo starting...');

  var manifest = window.__mini_pack.manifest;
  var allChunks = Object.keys(manifest.chunks);
  allChunks.forEach(function(n) { setChunkStatus(n, 'pending', 'Pending'); });

  // Collect entry chunks and their transitive deps — these load upfront
  var entryChunks = [];
  var upfrontSet = {};
  for (var n in manifest.chunks) {
    if (manifest.chunks.hasOwnProperty(n) && manifest.chunks[n].isEntry) {
      entryChunks.push(n);
    }
  }
  function collectDeps(name, set) {
    if (set[name]) return;
    set[name] = true;
    var deps = (manifest.chunks[name] && manifest.chunks[name].dependencies) || [];
    deps.forEach(function(d) { collectDeps(d, set); });
  }
  entryChunks.forEach(function(n) { collectDeps(n, upfrontSet); });

  var upfrontNames = Object.keys(upfrontSet);
  var ordered = topoSortChunks(manifest).filter(function(n) { return upfrontSet[n]; });

  addEvent('boot', '📋', 'Upfront chunks (entry + deps): ' + ordered.join(', '));
  addEvent('boot', '⏳', 'Async chunks will load on demand: ' +
    allChunks.filter(function(n) { return !upfrontSet[n]; }).join(', '));

  // Load upfront chunks sequentially
  var loadChain = Promise.resolve();
  ordered.forEach(function(n) {
    loadChain = loadChain.then(function() {
      if (n && manifest.chunks[n] && manifest.chunks[n].isShared) {
        addEvent('shared', '🔗', 'Loading shared dependency: ' + n + '.js');
      }
      return loadScript(n);
    });
  });

  loadChain.then(function() {
    addEvent('shared', '✅', 'All shared dependencies ready');
    addEvent('boot', '⚙️', 'Running entry bootstrap...');
    return bootstrapEntry();
  }).then(function() {
    addEvent('boot', '🎉', 'Page ready! Click "Load Dashboard" to test dynamic loading.');
    if (statusBar) {
      statusBar.textContent = 'Ready — main has executed, click Load Dashboard';
      statusBar.className = 'status-bar';
    }
  }).catch(function(err) {
    addEvent('error', '❌', 'Bootstrap failed', err.message || err);
  });
})();
</script>
</body>
</html>
`;

    const htmlPath = path.join(this.outputDir, 'index.html');
    return fse.writeFile(htmlPath, html, 'utf-8').then(() => htmlPath);
  }
}

module.exports = Bundler;
