const acorn = require('acorn');
const walk = require('acorn-walk');
const path = require('path');

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

  _normalizePath(filePath) {
    return filePath.replace(/\\/g, '/');
  }

  _collectUsedExports() {
    for (const [filePath, mod] of this.graph.modules) {
      this.usedExports.set(filePath, new Set());

      if (mod.isEntry) {
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

          const depMod = this.graph.getModule(imp.resolvedPath);
          if (!depMod) continue;

          const usedSet = this.usedExports.get(imp.resolvedPath);
          if (!usedSet) continue;

          const actuallyUsedNames = this._getActuallyUsedNames(mod, imp);

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
              if (!usedSet.has('default') && actuallyUsedNames.has(spec.local)) {
                usedSet.add('default');
                depMod.usedExports.add('default');
                changed = true;
              }
            } else if (spec.type === 'named') {
              if (!usedSet.has(spec.imported) && actuallyUsedNames.has(spec.local)) {
                usedSet.add(spec.imported);
                depMod.usedExports.add(spec.imported);
                changed = true;
              }
            }
          }

          if (imp.specifiers.length === 0) {
            usedSet.add('__sideEffect__');
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
          const actuallyUsedDynNames = this._getActuallyUsedDynamicNames(mod, dynImp);
          for (const exp of depMod.exports) {
            if (exp.type !== 'all' && !usedSet.has(exp.name) && actuallyUsedDynNames.has(exp.name)) {
              usedSet.add(exp.name);
              depMod.usedExports.add(exp.name);
            }
          }
        }
      }
    }
  }

  _getActuallyUsedNames(mod, imp) {
    const usedNames = new Set();

    if (imp.specifiers.length === 0) {
      return usedNames;
    }

    try {
      const code = mod.code;
      const importedLocals = new Set(imp.specifiers.map((s) => s.local));

      const ast = acorn.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
      });

      const importRanges = [];

      for (const node of ast.body) {
        if (node.type === 'ImportDeclaration' && node.source.value === imp.source) {
          for (const spec of node.specifiers) {
            importRanges.push({
              name: spec.local.name,
              start: spec.local.start || spec.local.name ? spec.local.start : node.start,
              end: spec.local.end || spec.local.name ? spec.local.end : node.end,
            });
          }
        }
      }

      const identifierRefs = new Set();

      const collectIdentifiers = (node, parent) => {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'Identifier' && importedLocals.has(node.name)) {
          const isInImportDecl = importRanges.some(
            (r) => r.name === node.name && node.start >= r.start && node.end <= r.end
          );

          if (!isInImportDecl) {
            if (parent && parent.type === 'Property' && parent.key === node && !parent.computed) {
            } else {
              identifierRefs.add(node.name);
            }
          }
        }

        for (const key of Object.keys(node)) {
          if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
          const child = node[key];
          if (child && typeof child === 'object') {
            if (Array.isArray(child)) {
              for (const item of child) {
                if (item && typeof item === 'object') {
                  collectIdentifiers(item, node);
                }
              }
            } else if (child.type) {
              collectIdentifiers(child, node);
            }
          }
        }
      };

      for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration') {
          collectIdentifiers(node, null);
        }
      }

      for (const name of identifierRefs) {
        usedNames.add(name);
      }
    } catch {
      for (const spec of imp.specifiers) {
        usedNames.add(spec.local);
      }
    }

    return usedNames;
  }

  _getActuallyUsedDynamicNames(mod, dynImp) {
    const usedNames = new Set();

    try {
      const code = mod.code;
      const ast = acorn.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
      });

      const importVarNames = new Set();

      walk.simple(ast, {
        VariableDeclarator(node) {
          if (node.init && node.init.type === 'AwaitExpression' && node.init.argument) {
            const arg = node.init.argument;
            if (arg.type === 'ImportExpression' && arg.source && arg.source.type === 'Literal' && arg.source.value === dynImp.source) {
              if (node.id && node.id.type === 'Identifier') {
                importVarNames.add(node.id.name);
              }
            }
          }
        },
      });

      if (importVarNames.size === 0) {
        usedNames.add('default');
        usedNames.add('init');
        return usedNames;
      }

      walk.simple(ast, {
        MemberExpression(node) {
          if (node.object && node.object.type === 'Identifier' && importVarNames.has(node.object.name)) {
            if (node.property && node.property.type === 'Identifier' && !node.computed) {
              usedNames.add(node.property.name);
            }
          }
        },
      });
    } catch {
      usedNames.add('default');
      usedNames.add('init');
    }

    if (usedNames.size === 0) {
      usedNames.add('default');
    }

    return usedNames;
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
        const used = this.usedExports.get(filePath) || new Set();
        const hasAnyUsed = used.size > 0;
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
