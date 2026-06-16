#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const DependencyResolver = require('./resolver');
const ModuleGraph = require('./module-graph');
const Optimizer = require('./optimizer');
const Bundler = require('./bundler');
const { SourceMapConsumer } = require('./source-map');

class BuildPipeline {
  constructor(options = {}) {
    this.entries = options.entries || [];
    this.output = options.output || './dist';
    this.sourcemap = options.sourcemap !== false;
    this.minify = options.minify || false;
    this.treeShaking = options.treeShaking !== false;
    this.format = options.format || 'esm';
    this.watch = options.watch || false;
    this.verbose = options.verbose || false;
    this.alias = options.alias || {};

    this.resolver = new DependencyResolver({ alias: this.alias });
    this.graph = null;
    this.lastBuildTime = 0;
    this.moduleTimestamps = new Map();
  }

  async build() {
    const startTime = Date.now();
    console.log('[mini-pack] Starting build...');

    if (this.entries.length === 0) {
      console.error('[mini-pack] Error: No entry files specified');
      process.exit(1);
    }

    this.graph = new ModuleGraph(this.resolver);

    for (const entry of this.entries) {
      const absPath = path.resolve(entry);
      if (!fs.existsSync(absPath)) {
        console.error(`[mini-pack] Error: Entry file not found: ${absPath}`);
        process.exit(1);
      }
    }

    this.graph.buildFromEntries(this.entries);

    const stats = this.graph.getStats();
    this._log(`Module graph built: ${stats.moduleCount} modules, ${stats.entryCount} entries`);
    if (stats.cycleCount > 0) {
      console.warn(`[mini-pack] Warning: ${stats.cycleCount} circular dependencies detected`);
    }

    if (this.treeShaking) {
      this._log('Running tree-shaking optimization...');
      const optimizer = new Optimizer(this.graph);
      optimizer.optimize();
      const optStats = optimizer.getStats();
      console.log(`[mini-pack] Tree-shaking: removed ${optStats.exportsRemoved} unused exports from ${optStats.modulesOptimized} modules`);
      const byMod = optStats.deadExportsByModule || {};
      const keys = Object.keys(byMod);
      if (keys.length > 0) {
        for (const k of keys) {
          const rel = path.relative(process.cwd(), k).replace(/\\/g, '/');
          const names = byMod[k].join(', ');
          console.log(`  - ${rel}: removed [ ${names} ]`);
        }
      }
    }

    const bundler = new Bundler(this.graph, {
      output: this.output,
      sourcemap: this.sourcemap,
      minify: this.minify,
      format: this.format,
    });

    const bundleResults = bundler.bundle();

    const results = await bundler.writeBundles(bundleResults);

    const buildTime = Date.now() - startTime;
    this.lastBuildTime = buildTime;
    this._saveModuleTimestamps();

    console.log(`[mini-pack] Build completed in ${buildTime}ms`);
    for (const result of results) {
      if (result.isManifest) {
        const stat = fs.statSync(result.outputPath);
        const sizeKB = (stat.size / 1024).toFixed(2);
        console.log(`  manifest.json (${sizeKB} KB) [manifest]`);
        continue;
      }
      if (result.outputPath && result.outputPath.endsWith('.html')) {
        const stat = fs.statSync(result.outputPath);
        const sizeKB = (stat.size / 1024).toFixed(2);
        console.log(`  index.html (${sizeKB} KB) [demo page]`);
        continue;
      }
      const size = Buffer.byteLength(result.code, 'utf-8');
      const sizeKB = (size / 1024).toFixed(2);
      console.log(`  ${result.name}.js (${sizeKB} KB)${result.isEntry ? ' [entry]' : ''}${result.isShared ? ' [shared]' : ''}`);
    }

    return results;
  }

  async incrementalBuild(changedFiles) {
    const startTime = Date.now();
    console.log(`[mini-pack] Incremental rebuild for ${changedFiles.length} changed file(s)...`);

    const affected = this.graph.rebuildFromEntries(this.entries, changedFiles);
    this._log(`Affected modules: ${affected.size}`);

    if (this.treeShaking) {
      const optimizer = new Optimizer(this.graph);
      optimizer.optimize();
      const optStats = optimizer.getStats();
      console.log(`[mini-pack] Tree-shaking: removed ${optStats.exportsRemoved} unused exports`);
      const byMod = optStats.deadExportsByModule || {};
      const keys = Object.keys(byMod);
      if (keys.length > 0) {
        for (const k of keys) {
          const rel = path.relative(process.cwd(), k).replace(/\\/g, '/');
          const names = byMod[k].join(', ');
          console.log(`  - ${rel}: removed [ ${names} ]`);
        }
      }
    }

    const bundler = new Bundler(this.graph, {
      output: this.output,
      sourcemap: this.sourcemap,
      minify: this.minify,
      format: this.format,
    });

    const results = bundler.bundle();
    await bundler.writeBundles(results);

    const buildTime = Date.now() - startTime;
    console.log(`[mini-pack] Incremental build completed in ${buildTime}ms`);

    this._saveModuleTimestamps();
    return results;
  }

  async watchMode() {
    console.log('[mini-pack] Starting watch mode...');

    await this.build();

    const watchPaths = this.entries.map((e) => path.resolve(path.dirname(e)));
    const allWatchedDirs = new Set(watchPaths);

    for (const [filePath] of this.graph.modules) {
      const dir = path.dirname(filePath);
      allWatchedDirs.add(dir);
    }

    const watcher = chokidar.watch(Array.from(allWatchedDirs), {
      ignored: /node_modules|dist/,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    let rebuildTimeout = null;
    const changedFiles = new Set();

    const scheduleRebuild = (filePath) => {
      changedFiles.add(filePath);

      if (rebuildTimeout) {
        clearTimeout(rebuildTimeout);
      }

      rebuildTimeout = setTimeout(async () => {
        const files = Array.from(changedFiles);
        changedFiles.clear();
        rebuildTimeout = null;

        try {
          await this.incrementalBuild(files);
        } catch (err) {
          console.error('[mini-pack] Rebuild error:', err.message);
        }
      }, 200);
    };

    watcher.on('change', (filePath) => {
      console.log(`[mini-pack] File changed: ${filePath}`);
      scheduleRebuild(filePath);
    });

    watcher.on('add', (filePath) => {
      console.log(`[mini-pack] File added: ${filePath}`);
      scheduleRebuild(filePath);
    });

    watcher.on('unlink', (filePath) => {
      console.log(`[mini-pack] File removed: ${filePath}`);
      scheduleRebuild(filePath);
    });

    console.log('[mini-pack] Watching for changes...');

    process.on('SIGINT', () => {
      console.log('\n[mini-pack] Stopping watch mode...');
      watcher.close();
      process.exit(0);
    });
  }

  _saveModuleTimestamps() {
    if (!this.graph) return;
    for (const [filePath, mod] of this.graph.modules) {
      this.moduleTimestamps.set(filePath, mod.mtime);
    }
  }

  _getChangedModules() {
    const changed = [];
    for (const [filePath, lastMtime] of this.moduleTimestamps) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > lastMtime) {
          changed.push(filePath);
        }
      } catch {
        changed.push(filePath);
      }
    }
    return changed;
  }

  _log(message) {
    if (this.verbose) {
      console.log(`[mini-pack] ${message}`);
    }
  }
}

const program = new Command();

program
  .name('mini-pack')
  .description('A minimal static asset bundler - simplified webpack')
  .version('1.0.0');

program
  .command('build')
  .description('Build the project')
  .requiredOption('-e, --entry <files...>', 'Entry file(s)')
  .option('-o, --output <dir>', 'Output directory', './dist')
  .option('--no-sourcemap', 'Disable source map generation')
  .option('--no-tree-shaking', 'Disable tree-shaking')
  .option('--minify', 'Enable minification')
  .option('-f, --format <type>', 'Output format (esm, cjs)', 'esm')
  .option('-v, --verbose', 'Verbose output')
  .option('--alias <pairs...>', 'Module aliases (key=value)')
  .action(async (options) => {
    const alias = {};
    if (options.alias) {
      for (const pair of options.alias) {
        const [key, value] = pair.split('=');
        alias[key] = value;
      }
    }

    const pipeline = new BuildPipeline({
      entries: options.entry,
      output: options.output,
      sourcemap: options.sourcemap,
      treeShaking: options.treeShaking,
      minify: options.minify,
      format: options.format,
      verbose: options.verbose,
      alias,
    });

    try {
      await pipeline.build();
    } catch (err) {
      console.error('[mini-pack] Build failed:', err.message);
      if (options.verbose) {
        console.error(err.stack);
      }
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Build and watch for changes')
  .requiredOption('-e, --entry <files...>', 'Entry file(s)')
  .option('-o, --output <dir>', 'Output directory', './dist')
  .option('--no-sourcemap', 'Disable source map generation')
  .option('--no-tree-shaking', 'Disable tree-shaking')
  .option('--minify', 'Enable minification')
  .option('-f, --format <type>', 'Output format (esm, cjs)', 'esm')
  .option('-v, --verbose', 'Verbose output')
  .option('--alias <pairs...>', 'Module aliases (key=value)')
  .action(async (options) => {
    const alias = {};
    if (options.alias) {
      for (const pair of options.alias) {
        const [key, value] = pair.split('=');
        alias[key] = value;
      }
    }

    const pipeline = new BuildPipeline({
      entries: options.entry,
      output: options.output,
      sourcemap: options.sourcemap,
      treeShaking: options.treeShaking,
      minify: options.minify,
      format: options.format,
      verbose: options.verbose,
      watch: true,
      alias,
    });

    try {
      await pipeline.watchMode();
    } catch (err) {
      console.error('[mini-pack] Watch mode failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('analyze')
  .description('Analyze the module graph without building')
  .requiredOption('-e, --entry <files...>', 'Entry file(s)')
  .option('-v, --verbose', 'Verbose output')
  .action((options) => {
    const resolver = new DependencyResolver();
    const graph = new ModuleGraph(resolver);

    graph.buildFromEntries(options.entry);

    const stats = graph.getStats();
    console.log('\n=== Module Graph Analysis ===\n');
    console.log(`Total modules: ${stats.moduleCount}`);
    console.log(`Total size: ${(stats.totalSize / 1024).toFixed(2)} KB`);
    console.log(`Entry points: ${stats.entryCount}`);
    console.log(`Dynamic entry points: ${stats.dynamicEntryCount}`);
    console.log(`Circular dependencies: ${stats.cycleCount}`);

    console.log('\n=== Module List ===\n');
    const topoOrder = graph.topologicalSort();
    for (let i = 0; i < topoOrder.length; i++) {
      const mod = graph.getModule(topoOrder[i]);
      const relPath = path.relative(process.cwd(), topoOrder[i]);
      const deps = mod.dependencies.length;
      const exports = mod.exports.length;
      const flags = [
        mod.isEntry ? 'ENTRY' : '',
        mod.isDynamicEntry ? 'DYNAMIC' : '',
        !mod.sideEffects ? 'PURE' : '',
      ].filter(Boolean).join('|');

      console.log(`  [${i}] ${relPath} (deps: ${deps}, exports: ${exports})${flags ? ' [' + flags + ']' : ''}`);
    }

    if (graph.cycles.length > 0) {
      console.log('\n=== Circular Dependencies ===\n');
      for (const cycle of graph.cycles) {
        console.log(`  ${cycle.join(' -> ')}`);
      }
    }

    console.log('\n=== Topological Order ===\n');
    console.log(topoOrder.map((p) => path.relative(process.cwd(), p)).join('\n  '));
  });

program
  .command('sourcemap')
  .description('Verify source map: given bundled file + line/col, return original file and line')
  .requiredOption('-f, --file <path>', 'Bundled JS file path (e.g. dist/main.js)')
  .requiredOption('-l, --line <num>', 'Line number in bundled file (1-based)', parseInt)
  .option('-c, --column <num>', 'Column number in bundled file (0-based)', parseInt, 0)
  .option('--show-context', 'Show surrounding lines of original source')
  .action((options) => {
    const bundleAbs = path.resolve(options.file);
    if (!fs.existsSync(bundleAbs)) {
      console.error(`[mini-pack] Error: Bundle file not found: ${bundleAbs}`);
      process.exit(1);
    }

    const bundleDir = path.dirname(bundleAbs);
    const bundleName = path.basename(bundleAbs);
    const code = fs.readFileSync(bundleAbs, 'utf-8');
    const codeLines = code.split('\n');

    if (options.line < 1 || options.line > codeLines.length) {
      console.error(`[mini-pack] Error: line ${options.line} out of range (bundle has ${codeLines.length} lines)`);
      process.exit(1);
    }

    let mapPath = bundleAbs + '.map';
    let mapData = null;

    if (fs.existsSync(mapPath)) {
      mapData = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    } else {
      const inlineMatch = code.match(/\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/);
      if (inlineMatch) {
        try {
          const decoded = Buffer.from(inlineMatch[1], 'base64').toString('utf-8');
          mapData = JSON.parse(decoded);
        } catch (err) {
          console.error('[mini-pack] Error: Failed to decode inline source map:', err.message);
          process.exit(1);
        }
      }
    }

    if (!mapData) {
      console.error(`[mini-pack] Error: No source map found for ${bundleAbs} (tried ${mapPath} and inline)`);
      process.exit(1);
    }

    const consumer = new SourceMapConsumer(mapData);

    const targetLine = options.line;
    const targetCol = options.column;
    const pos = consumer.originalPositionFor({ line: targetLine, column: targetCol });

    console.log('\n=== Source Map Verification ===\n');
    console.log(`Bundle file : ${bundleName}`);
    console.log(`Query       : line ${targetLine}, col ${targetCol}`);
    console.log(`Bundle line : ${JSON.stringify(codeLines[targetLine - 1] || '')}`);
    console.log('');

    if (!pos.source) {
      console.log('Result      : ❌ No mapping found for this position');
      console.log('              (This usually means the position is inside runtime wrapper');
      console.log('               or helper code with no original source mapping)');

      let found = null;
      let nearestLine = null;
      for (let l = targetLine; l >= 1; l--) {
        const p = consumer.originalPositionFor({ line: l, column: 0 });
        if (p.source) { found = p; nearestLine = l; break; }
      }
      if (found) {
        console.log(`\nNearest earlier mapping is at bundle line ${nearestLine}:`);
        printMapping(found, bundleDir, options.showContext);
      }
      console.log('');
      process.exit(0);
    }

    console.log('Result      : ✅ Mapping found!');
    console.log('');
    printMapping(pos, bundleDir, options.showContext);

    if (pos.source && mapData.sourcesContent) {
      const sourceIdx = mapData.sources.indexOf(pos.source);
      if (sourceIdx >= 0 && mapData.sourcesContent[sourceIdx]) {
        const origLines = mapData.sourcesContent[sourceIdx].split(/\r?\n/);
        const origLine = pos.line;
        const from = Math.max(1, origLine - 2);
        const to = Math.min(origLines.length, origLine + 2);
        console.log('\n=== Original Source Context (from sourcesContent) ===\n');
        for (let i = from; i <= to; i++) {
          const marker = i === origLine ? ' -> ' : '    ';
          const lineStr = String(i).padStart(4, ' ');
          console.log(`${marker}${lineStr} | ${origLines[i - 1] || ''}`);
        }
      }
    }
    console.log('');

    function printMapping(p, baseDir, showCtx) {
      const absSource = path.resolve(baseDir, p.source);
      console.log(`Source file : ${p.source}`);
      console.log(`Abs path    : ${absSource}`);
      console.log(`Original L/C: line ${p.line}, col ${p.column}`);
      if (p.name) console.log(`Symbol name : ${p.name}`);

      if (showCtx && fs.existsSync(absSource)) {
        const srcLines = fs.readFileSync(absSource, 'utf-8').split(/\r?\n/);
        const from = Math.max(1, p.line - 2);
        const to = Math.min(srcLines.length, p.line + 2);
        console.log('\n=== Original Source Context (disk) ===\n');
        for (let i = from; i <= to; i++) {
          const marker = i === p.line ? ' -> ' : '    ';
          const lineStr = String(i).padStart(4, ' ');
          console.log(`${marker}${lineStr} | ${srcLines[i - 1] || ''}`);
        }
      }
    }
  });

if (process.argv.length <= 2) {
  const entry = process.argv[2] || null;
  const outputIdx = process.argv.indexOf('--output') || process.argv.indexOf('-o');
  const output = outputIdx > -1 ? process.argv[outputIdx + 1] : './dist';

  if (entry) {
    const pipeline = new BuildPipeline({
      entries: [entry],
      output,
      sourcemap: !process.argv.includes('--no-sourcemap'),
      treeShaking: !process.argv.includes('--no-tree-shaking'),
      verbose: process.argv.includes('--verbose'),
    });

    pipeline.build().catch((err) => {
      console.error('[mini-pack] Build failed:', err.message);
      process.exit(1);
    });
  } else {
    program.help();
  }
} else {
  program.parse();
}

module.exports = BuildPipeline;
