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

    const chunkList = results
      .filter((r) => !r.isManifest)
      .map((r) => {
        const m = (manifest && manifest.chunks && manifest.chunks[r.name]) || {};
        return {
          name: r.name,
          sizeKB: (Buffer.byteLength(r.code, 'utf-8') / 1024).toFixed(2),
          isEntry: !!r.isEntry,
          isShared: !!r.isShared,
          moduleCount: (m.modules || []).length,
          modules: m.modules || [],
          dependencies: m.dependencies || [],
        };
      });

    const chunkListHtml = chunkList
      .map((c) => {
        const badge = c.isEntry ? '📦 Entry' : c.isShared ? '🔗 Shared' : '🧩 Chunk';
        const depsStr = c.dependencies.length > 0 ? `<br><small>Deps: ${c.dependencies.join(', ')}</small>` : '';
        const modsStr = c.modules.length > 0 ? `<br><small>Modules: ${c.modules.join(', ')}</small>` : '';
        return `<li><strong>${c.name}.js</strong> <em>(${c.sizeKB} KB)</em> <span style="color:#888">${badge}</span>${depsStr}${modsStr}</li>`;
      })
      .join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>mini-pack Demo</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 900px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; color: #333; }
  h2 { color: #555; border-bottom: 1px solid #eee; padding-bottom: 8px; }
  .controls { margin: 16px 0; display: flex; gap: 10px; flex-wrap: wrap; }
  button { padding: 10px 18px; font-size: 14px; border: none; border-radius: 4px; cursor: pointer; background: #4a90d9; color: white; transition: background 0.2s; }
  button:hover { background: #357abd; }
  button.secondary { background: #6c757d; }
  button.secondary:hover { background: #5a6268; }
  .log-panel { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 4px; font-family: 'Consolas', 'Monaco', monospace; font-size: 13px; max-height: 360px; overflow-y: auto; line-height: 1.5; }
  .log-entry { margin: 4px 0; padding: 2px 0; border-bottom: 1px solid #2a2a2a; }
  .log-entry:last-child { border-bottom: none; }
  .log-log { color: #d4d4d4; }
  .log-info { color: #4ec9b0; }
  .log-warn { color: #dcdcaa; }
  .log-error { color: #f48771; }
  .log-ts { color: #808080; margin-right: 8px; }
  .chunk-list { list-style: none; padding: 0; }
  .chunk-list li { padding: 8px 12px; border-left: 3px solid #4a90d9; background: #f8f9fa; margin-bottom: 6px; border-radius: 0 4px 4px 0; }
  .note { background: #fff3cd; color: #856404; padding: 12px 16px; border-radius: 4px; margin: 12px 0; }
  .status { padding: 6px 12px; border-radius: 4px; background: #e8f5e9; color: #2e7d32; display: inline-block; font-size: 13px; }
  .status.error { background: #ffebee; color: #c62828; }
</style>
</head>
<body>
<div class="container">
  <h1>🗜️ mini-pack Browser Demo</h1>
  <p>Test side-effect modules, dynamic chunk loading, shared dependencies, and source maps.</p>

  <div class="note">
    <strong>Tip:</strong> Open the DevTools console (F12) to see the same logs. Click buttons below to trigger dynamic loading and observe that shared dependencies only execute once.
  </div>

  <h2>🛠️ Build Artifacts</h2>
  <ul class="chunk-list">
    ${chunkListHtml}
  </ul>

  <h2>▶️ Runtime Controls</h2>
  <div class="controls">
    <button id="btn-dashboard">Load Dashboard (Dynamic)</button>
    <button id="btn-dashboard-again" class="secondary">Load Dashboard Again (Cached)</button>
    <button id="btn-check-cache" class="secondary">Check Module Cache</button>
    <button id="btn-clear-log" class="secondary">Clear Log Panel</button>
  </div>
  <div style="margin: 8px 0;">
    <span id="status-label" class="status">Page loaded — main.js has executed automatically</span>
  </div>

  <h2>📋 Console Output</h2>
  <div class="log-panel" id="log-panel"></div>
</div>

<script>
(function() {
  var __MANIFEST__ = ${manifestJson};
  if (typeof window !== 'undefined') {
    window.__mini_pack = window.__mini_pack || {};
    window.__mini_pack.manifest = __MANIFEST__;
  }
})();
</script>
<script>
(function() {
  var panel = document.getElementById('log-panel');
  var statusLabel = document.getElementById('status-label');

  var originalLog = console.log;
  var originalWarn = console.warn;
  var originalError = console.error;
  var originalInfo = console.info;

  function ts() {
    var d = new Date();
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function addLog(level, args) {
    var entry = document.createElement('div');
    entry.className = 'log-entry log-' + level;
    var parts = Array.prototype.slice.call(args).map(function(a) {
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }
      return String(a);
    });
    entry.innerHTML = '<span class="log-ts">[' + ts() + ']</span>' + parts.join(' ');
    panel.appendChild(entry);
    panel.scrollTop = panel.scrollHeight;
  }

  console.log = function() { originalLog.apply(console, arguments); addLog('log', arguments); };
  console.info = function() { originalInfo.apply(console, arguments); addLog('info', arguments); };
  console.warn = function() { originalWarn.apply(console, arguments); addLog('warn', arguments); };
  console.error = function() { originalError.apply(console, arguments); addLog('error', arguments); };

  window.addEventListener('error', function(e) {
    addLog('error', ['[Window Error]', e.message, '(' + e.filename + ':' + e.lineno + ')']);
    if (statusLabel) {
      statusLabel.textContent = 'Error: ' + e.message;
      statusLabel.className = 'status error';
    }
  });

  window.addEventListener('unhandledrejection', function(e) {
    addLog('error', ['[Unhandled Promise]', String(e.reason)]);
    if (statusLabel) {
      statusLabel.textContent = 'Promise rejection: ' + String(e.reason);
      statusLabel.className = 'status error';
    }
  });

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
      addLog('warn', ['Chunk dependency cycle detected! Falling back to natural order.']);
      return names;
    }
    return result;
  }

  function loadScript(name) {
    return new Promise(function(resolve, reject) {
      var ns = window.__mini_pack || {};
      if (ns.chunks && ns.chunks[name]) { resolve(); return; }
      if (ns.chunkPromises && ns.chunkPromises[name]) { ns.chunkPromises[name].then(resolve, reject); return; }
      var script = document.createElement('script');
      script.src = name + '.js';
      script.onload = function() {
        if (window.__mini_pack) {
          window.__mini_pack.chunks = window.__mini_pack.chunks || {};
          window.__mini_pack.chunks[name] = true;
        }
        resolve();
      };
      script.onerror = function() { reject(new Error('Failed to load ' + name + '.js')); };
      document.head.appendChild(script);
    });
  }

  function loadChunksInOrder(orderedNames) {
    var p = Promise.resolve();
    orderedNames.forEach(function(n) {
      p = p.then(function() {
        addLog('info', ['Loading chunk: ' + n + '.js ...']);
        return loadScript(n);
      });
    });
    return p;
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
    addLog('info', ['Bootstrapping entry chunk ' + entryName + ' (module ' + entryId + ')...']);
    try {
      var exp = ns.require(entryId);
      if (typeof exp === 'object' && exp) {
        for (var k in exp) {
          if (exp.hasOwnProperty(k) && typeof exp[k] === 'function') {
            window[k] = exp[k];
          }
        }
      }
      return exp;
    } catch (e) {
      addLog('error', ['Entry bootstrap failed:', e.message || e]);
      throw e;
    }
  }

  function loadDashboard(attemptLabel) {
    var ns = window.__mini_pack;
    if (!ns) { addLog('error', ['__mini_pack runtime not initialized']); return Promise.reject(); }
    addLog('info', ['— Triggering dashboard load (' + attemptLabel + ')... —']);
    var chunkName = 'dashboard';
    if (!ns.manifest || !ns.manifest.chunks || !ns.manifest.chunks[chunkName]) {
      addLog('error', ['Manifest has no info for chunk: ' + chunkName]);
      return Promise.reject();
    }
    var dashInfo = ns.manifest.chunks[chunkName];
    var entryId = dashInfo.entryModuleId;
    var loadPromise;
    if (ns.loadChunk) {
      loadPromise = ns.loadChunk(chunkName);
    } else {
      var deps = dashInfo.dependencies || [];
      loadPromise = Promise.all(deps.map(function(d) { return loadScript(d); })).then(function() { return loadScript(chunkName); });
    }
    return loadPromise.then(function() {
      addLog('info', ['Dashboard chunk ready. Requiring entry module ' + entryId + ' and calling init()...']);
      if (!ns.require) { addLog('error', ['__mini_pack.require missing']); return; }
      var dashExports = ns.require(entryId);
      if (dashExports && typeof dashExports.init === 'function') {
        dashExports.init();
      }
      return dashExports;
    }).then(function(exports) {
      if (statusLabel) {
        statusLabel.textContent = 'Dashboard loaded successfully (' + attemptLabel + ')';
        statusLabel.className = 'status';
      }
      addLog('info', ['— Dashboard promise resolved —']);
      return exports;
    }).catch(function(err) {
      addLog('error', ['Dashboard load failed:', err.message || err]);
      if (statusLabel) {
        statusLabel.textContent = 'Failed: ' + (err.message || err);
        statusLabel.className = 'status error';
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
    addLog('info', ['=== Module Cache State ===']);
    addLog('log', ['Chunks loaded:', Object.keys(ns.chunks || {}).join(', ') || '(none)']);
    var cacheKeys = Object.keys(ns.cache || {});
    addLog('log', ['Module cache size:', cacheKeys.length, '(ids: ' + cacheKeys.join(', ') + ')']);
    if (ns.cache) {
      for (var id in ns.cache) {
        if (ns.cache.hasOwnProperty(id)) {
          var exp = ns.cache[id];
          var keys = Object.keys(exp).filter(function(k) { return k !== 'default' || Object.keys(exp).length > 1; });
          addLog('log', ['  id=' + id + ' exports:', keys.length > 0 ? '{' + Object.keys(exp).join(', ') + '}' : '{}']);
        }
      }
    }
    if (ns.manifest) {
      addLog('info', ['=== Manifest: Chunk Dependencies ===']);
      for (var cname in ns.manifest.chunks) {
        if (ns.manifest.chunks.hasOwnProperty(cname)) {
          var c = ns.manifest.chunks[cname];
          addLog('log', ['  ' + cname + ' → deps: [' + (c.dependencies || []).join(', ') + '], modules: ' + (c.modules || []).length + ', entryId: ' + (c.entryModuleId != null ? c.entryModuleId : '(none)')]);
        }
      }
    }
    if (statusLabel) {
      statusLabel.textContent = 'Cache inspected — check console above';
      statusLabel.className = 'status';
    }
  });
  if (btn4) btn4.addEventListener('click', function() { panel.innerHTML = ''; });

  addLog('info', ['=== Demo page bootstrap starting... ===']);

  var ordered = topoSortChunks(window.__mini_pack && window.__mini_pack.manifest);
  addLog('log', ['Chunk load order (from manifest):', ordered.join(' → ')]);

  loadChunksInOrder(ordered).then(function() {
    addLog('info', ['All entry chunks loaded. Bootstrapping entry module...']);
    bootstrapEntry();
    if (statusLabel) {
      statusLabel.textContent = 'Ready — main has executed, you can load dashboard now';
      statusLabel.className = 'status';
    }
    addLog('info', ['=== Bootstrap complete ===']);
  }).catch(function(err) {
    addLog('error', ['Bootstrap failed:', err.message || err]);
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
