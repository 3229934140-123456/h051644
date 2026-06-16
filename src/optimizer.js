const acorn = require('acorn');
const walk = require('acorn-walk');

class Optimizer {
  constructor(moduleGraph, options = {}) {
    this.graph = moduleGraph;
    this.options = options;
    this.usedExports = new Map();
    this.deadExports = new Map();
    this.removedCount = 0;
  }

  optimize() {
    this._collectUsedExports();
    this._markDeadExports();
    this._removeDeadCode();
    return this;
  }

  _collectUsedExports() {
    for (const [filePath, mod] of this.graph.modules) {
      this.usedExports.set(filePath, new Set());

      if (mod.isEntry || mod.isDynamicEntry) {
        for (const exp of mod.exports) {
          if (exp.type === 'all') continue;
          this.usedExports.get(filePath).add(exp.name);
          mod.usedExports.add(exp.name);
        }
      }
    }

    let changed = true;
    let iterations = 0;
    const maxIterations = this.graph.modules.size * 2;

    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;

      for (const [filePath, mod] of this.graph.modules) {
        for (const imp of mod.imports) {
          if (!imp.resolvedPath) continue;

          const depPath = imp.resolvedPath.replace(/\\/g, '/');
          const depMod = this.graph.getModule(imp.resolvedPath);
          if (!depMod) continue;

          const usedSet = this.usedExports.get(depPath);
          if (!usedSet) continue;

          for (const spec of imp.specifiers) {
            if (spec.type === 'namespace') {
              for (const exp of depMod.exports) {
                if (exp.type !== 'all' && !usedSet.has(exp.name)) {
                  usedSet.add(exp.name);
                  depMod.usedExports.add(exp.name);
                  changed = true;
                }
              }
            } else if (spec.type === 'default') {
              if (!usedSet.has('default')) {
                usedSet.add('default');
                depMod.usedExports.add('default');
                changed = true;
              }
            } else if (spec.type === 'named') {
              if (!usedSet.has(spec.imported)) {
                usedSet.add(spec.imported);
                depMod.usedExports.add(spec.imported);
                changed = true;
              }
            }
          }
        }
      }
    }

    for (const [filePath, mod] of this.graph.modules) {
      for (const dynImp of mod.dynamicImports) {
        if (!dynImp.resolvedPath) continue;
        const depMod = this.graph.getModule(dynImp.resolvedPath);
        if (!depMod) continue;
        const usedSet = this.usedExports.get(dynImp.resolvedPath);
        if (usedSet) {
          for (const exp of depMod.exports) {
            if (exp.type !== 'all' && !usedSet.has(exp.name)) {
              usedSet.add(exp.name);
              depMod.usedExports.add(exp.name);
            }
          }
        }
      }
    }
  }

  _markDeadExports() {
    for (const [filePath, mod] of this.graph.modules) {
      const used = this.usedExports.get(filePath) || new Set();
      const dead = [];

      for (const exp of mod.exports) {
        if (exp.type === 'all') continue;
        if (exp.nodeType === 'reexport' || exp.nodeType === 'reexport-all') continue;
        if (!used.has(exp.name)) {
          dead.push(exp);
        }
      }

      if (dead.length > 0) {
        this.deadExports.set(filePath, dead);
      }
    }
  }

  _removeDeadCode() {
    for (const [filePath, deadExports] of this.deadExports) {
      const mod = this.graph.getModule(filePath);
      if (!mod) continue;

      if (!mod.sideEffects && !mod.isEntry && !mod.isDynamicEntry) {
        const hasAnyUsed = (this.usedExports.get(filePath) || new Set()).size > 0;
        if (!hasAnyUsed) {
          this.removedCount++;
          continue;
        }
      }

      const deadNames = new Set(deadExports.map((e) => e.local || e.name));
      const optimizedCode = this._removeDeadExportsFromCode(mod.code, deadNames, mod);
      if (optimizedCode !== mod.code) {
        mod.code = optimizedCode;
        mod.exports = mod.exports.filter(
          (exp) => !deadNames.has(exp.local || exp.name)
        );
        this.removedCount += deadExports.length;
      }
    }
  }

  _removeDeadExportsFromCode(code, deadNames, mod) {
    try {
      const ast = acorn.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
      });

      const removals = [];

      for (const node of ast.body) {
        if (node.type === 'ExportNamedDeclaration' && node.declaration) {
          if (node.declaration.type === 'VariableDeclaration') {
            const allDead = node.declaration.declarations.every((d) =>
              deadNames.has(d.id.name)
            );
            if (allDead) {
              removals.push({
                start: node.start,
                end: node.end,
              });
            } else {
              const liveDecls = node.declaration.declarations.filter(
                (d) => !deadNames.has(d.id.name)
              );
              if (liveDecls.length < node.declaration.declarations.length) {
                const keyword = node.declaration.kind;
                const liveCode = liveDecls
                  .map((d) => {
                    if (d.init) {
                      return `${keyword} ${d.id.name} = ${code.slice(d.init.start, d.init.end)}`;
                    }
                    return `${keyword} ${d.id.name}`;
                  })
                  .join(', ');
                removals.push({
                  start: node.start,
                  end: node.end,
                  replacement: `export ${liveCode};`,
                });
              }
            }
          } else if (
            node.declaration.type === 'FunctionDeclaration' &&
            deadNames.has(node.declaration.id.name)
          ) {
            removals.push({
              start: node.start,
              end: node.end,
            });
          } else if (
            node.declaration.type === 'ClassDeclaration' &&
            deadNames.has(node.declaration.id.name)
          ) {
            removals.push({
              start: node.start,
              end: node.end,
            });
          }
        } else if (
          node.type === 'ExportDefaultDeclaration' &&
          deadNames.has('default')
        ) {
          removals.push({
            start: node.start,
            end: node.end,
          });
        } else if (node.type === 'ExportNamedDeclaration' && node.specifiers) {
          const liveSpecs = node.specifiers.filter(
            (s) => !deadNames.has(s.exported.name)
          );
          if (liveSpecs.length === 0) {
            removals.push({
              start: node.start,
              end: node.end,
            });
          } else if (liveSpecs.length < node.specifiers.length) {
            const specCode = liveSpecs
              .map((s) => {
                if (s.local.name === s.exported.name) return s.local.name;
                return `${s.local.name} as ${s.exported.name}`;
              })
              .join(', ');
            removals.push({
              start: node.start,
              end: node.end,
              replacement: `export { ${specCode} };`,
            });
          }
        }
      }

      if (removals.length === 0) return code;

      removals.sort((a, b) => b.start - a.start);

      let result = code;
      for (const r of removals) {
        const replacement = r.replacement !== undefined ? r.replacement : '';
        result = result.slice(0, r.start) + replacement + result.slice(r.end);
      }

      return result;
    } catch {
      return code;
    }
  }

  getStats() {
    return {
      modulesOptimized: this.deadExports.size,
      exportsRemoved: this.removedCount,
      deadExportsByModule: Object.fromEntries(
        Array.from(this.deadExports.entries()).map(([fp, exps]) => [
          fp,
          exps.map((e) => e.name),
        ])
      ),
    };
  }
}

module.exports = Optimizer;
