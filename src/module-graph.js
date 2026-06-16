const path = require('path');
const fs = require('fs');

class ModuleNode {
  constructor(filePath) {
    this.filePath = filePath;
    this.code = '';
    this.ast = null;
    this.imports = [];
    this.exports = [];
    this.dynamicImports = [];
    this.dependencies = [];
    this.dynamicDependencies = [];
    this.usedExports = new Set();
    this.isEntry = false;
    this.isDynamicEntry = false;
    this.chunkId = null;
    this.isExternal = false;
    this.mtime = 0;
    this.size = 0;
    this.sideEffects = true;
  }
}

class ModuleGraph {
  constructor(resolver, options = {}) {
    this.resolver = resolver;
    this.modules = new Map();
    this.entries = [];
    this.dynamicEntries = [];
    this.cycles = [];
    this.options = options;
  }

  buildFromEntry(entryPath) {
    const absPath = path.resolve(entryPath);
    this.entries = [absPath];
    this._buildGraph(absPath, true);
    this._detectCycles();
    return this;
  }

  buildFromEntries(entryPaths) {
    this.entries = entryPaths.map((p) => path.resolve(p));
    for (const entry of this.entries) {
      this._buildGraph(entry, true);
    }
    this._detectCycles();
    return this;
  }

  _buildGraph(filePath, isEntry = false, traverseStack = new Set()) {
    const normalizedPath = path.normalize(filePath);

    if (this.modules.has(normalizedPath)) {
      const existing = this.modules.get(normalizedPath);
      if (isEntry) existing.isEntry = true;
      return existing;
    }

    if (!fs.existsSync(normalizedPath)) {
      console.warn(`[mini-pack] Module not found: ${normalizedPath}`);
      return null;
    }

    const stat = fs.statSync(normalizedPath);
    const parsed = this.resolver.parse(normalizedPath);

    const moduleNode = new ModuleNode(normalizedPath);
    moduleNode.code = parsed.code;
    moduleNode.ast = parsed.ast;
    moduleNode.imports = parsed.imports;
    moduleNode.exports = parsed.exports;
    moduleNode.dynamicImports = parsed.dynamicImports;
    moduleNode.isEntry = isEntry;
    moduleNode.mtime = stat.mtimeMs;
    moduleNode.size = stat.size;

    this._checkSideEffects(normalizedPath, moduleNode);

    this.modules.set(normalizedPath, moduleNode);

    traverseStack.add(normalizedPath);

    for (const imp of parsed.imports) {
      if (!imp.resolvedPath) continue;
      const depPath = path.normalize(imp.resolvedPath);

      if (traverseStack.has(depPath)) {
        continue;
      }

      const depModule = this._buildGraph(depPath, false, new Set(traverseStack));
      if (depModule) {
        moduleNode.dependencies.push(depPath);
      }
    }

    for (const dynImp of parsed.dynamicImports) {
      if (!dynImp.resolvedPath) continue;
      const depPath = path.normalize(dynImp.resolvedPath);

      moduleNode.dynamicDependencies.push(depPath);

      const existingModule = this.modules.get(depPath);
      if (!existingModule) {
        const dynModule = this._buildGraph(depPath, false, new Set(traverseStack));
        if (dynModule) {
          dynModule.isDynamicEntry = true;
          this.dynamicEntries.push(depPath);
        }
      } else if (!existingModule.isDynamicEntry) {
        existingModule.isDynamicEntry = true;
        this.dynamicEntries.push(depPath);
      }
    }

    traverseStack.delete(normalizedPath);
    return moduleNode;
  }

  _checkSideEffects(filePath, moduleNode) {
    const dir = path.dirname(filePath);
    const pjPath = path.join(dir, 'package.json');
    if (fs.existsSync(pjPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pjPath, 'utf-8'));
        if ('sideEffects' in pkg) {
          if (pkg.sideEffects === false) {
            moduleNode.sideEffects = false;
          } else if (Array.isArray(pkg.sideEffects)) {
            const patterns = pkg.sideEffects;
            moduleNode.sideEffects = patterns.some((pattern) =>
              filePath.includes(pattern.replace('*', ''))
            );
          }
        }
      } catch {}
    }
  }

  _detectCycles() {
    const visited = new Set();
    const inStack = new Set();
    const stack = [];
    this.cycles = [];

    const dfs = (filePath) => {
      visited.add(filePath);
      inStack.add(filePath);
      stack.push(filePath);

      const mod = this.modules.get(filePath);
      if (!mod) return;

      for (const dep of mod.dependencies) {
        if (!visited.has(dep)) {
          dfs(dep);
        } else if (inStack.has(dep)) {
          const cycleStart = stack.indexOf(dep);
          const cycle = stack.slice(cycleStart);
          this.cycles.push([...cycle, dep]);
        }
      }

      stack.pop();
      inStack.delete(filePath);
    };

    for (const [filePath] of this.modules) {
      if (!visited.has(filePath)) {
        dfs(filePath);
      }
    }

    if (this.cycles.length > 0) {
      console.warn(
        `[mini-pack] Detected ${this.cycles.length} circular dependency cycle(s):`
      );
      for (const cycle of this.cycles) {
        console.warn(`  ${cycle.join(' -> ')}`);
      }
    }
  }

  topologicalSort() {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (filePath, ancestors = []) => {
      if (visited.has(filePath)) return;
      if (visiting.has(filePath)) {
        return;
      }

      visiting.add(filePath);
      const mod = this.modules.get(filePath);
      if (!mod) return;

      for (const dep of mod.dependencies) {
        if (!visited.has(dep)) {
          visit(dep, [...ancestors, filePath]);
        }
      }

      visiting.delete(filePath);
      visited.add(filePath);
      sorted.push(filePath);
    };

    for (const entry of this.entries) {
      visit(entry);
    }

    for (const [filePath, mod] of this.modules) {
      if (!visited.has(filePath)) {
        visit(filePath);
      }
    }

    return sorted;
  }

  getDependents(filePath) {
    const dependents = [];
    for (const [modPath, mod] of this.modules) {
      if (mod.dependencies.includes(filePath)) {
        dependents.push(modPath);
      }
      if (mod.dynamicDependencies.includes(filePath)) {
        dependents.push(modPath);
      }
    }
    return dependents;
  }

  getTransitiveDependents(filePath) {
    const result = new Set();
    const queue = [filePath];

    while (queue.length > 0) {
      const current = queue.shift();
      const dependents = this.getDependents(current);
      for (const dep of dependents) {
        if (!result.has(dep)) {
          result.add(dep);
          queue.push(dep);
        }
      }
    }

    return result;
  }

  getModule(filePath) {
    return this.modules.get(path.normalize(filePath));
  }

  getAllModules() {
    return Array.from(this.modules.values());
  }

  getStats() {
    let totalSize = 0;
    for (const mod of this.modules.values()) {
      totalSize += mod.size;
    }
    return {
      moduleCount: this.modules.size,
      totalSize,
      entryCount: this.entries.length,
      dynamicEntryCount: this.dynamicEntries.length,
      cycleCount: this.cycles.length,
    };
  }

  invalidate(changedFiles) {
    const allAffected = new Set();

    for (const file of changedFiles) {
      const normalized = path.normalize(file);
      allAffected.add(normalized);

      const transitiveDeps = this.getTransitiveDependents(normalized);
      for (const dep of transitiveDeps) {
        allAffected.add(dep);
      }
    }

    for (const filePath of allAffected) {
      this.modules.delete(filePath);
      this.resolver.invalidate(filePath);
    }

    this.dynamicEntries = [];
    return allAffected;
  }

  rebuildFromEntries(entryPaths, changedFiles) {
    const affected = this.invalidate(changedFiles);

    for (const entry of entryPaths) {
      const absPath = path.resolve(entry);
      this._buildGraph(absPath, true);
    }

    this._detectCycles();
    return affected;
  }
}

module.exports = ModuleGraph;
