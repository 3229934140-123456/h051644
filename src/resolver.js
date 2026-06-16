const acorn = require('acorn');
const walk = require('acorn-walk');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');

const SUPPORTED_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const NODE_MODULES = 'node_modules';

class DependencyResolver {
  constructor(options = {}) {
    this.alias = options.alias || {};
    this.extensions = options.extensions || SUPPORTED_EXTENSIONS;
    this.conditions = options.conditions || ['import', 'default'];
    this._cache = new Map();
  }

  resolve(importPath, fromFile) {
    const cacheKey = `${importPath}::${fromFile}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    let resolved = this._tryResolve(importPath, fromFile);
    if (!resolved) {
      const err = new Error(
        `Cannot resolve "${importPath}" from "${fromFile}"`
      );
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }

    this._cache.set(cacheKey, resolved);
    return resolved;
  }

  _tryResolve(importPath, fromFile) {
    if (importPath in this.alias) {
      importPath = this.alias[importPath];
    }

    if (importPath.startsWith('.') || path.isAbsolute(importPath)) {
      return this._resolveRelative(importPath, fromFile);
    }

    return this._resolveNodeModules(importPath, fromFile);
  }

  _resolveRelative(importPath, fromFile) {
    const dir = path.dirname(fromFile);
    const absPath = path.resolve(dir, importPath);
    return this._resolveFileOrDir(absPath);
  }

  _resolveNodeModules(importPath, fromFile) {
    let dir = path.dirname(fromFile);
    while (true) {
      const candidate = path.join(dir, NODE_MODULES, importPath);
      const resolved = this._resolveFileOrDir(candidate);
      if (resolved) return resolved;

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  _resolveFileOrDir(absPath) {
    const direct = this._tryExtensions(absPath);
    if (direct) return direct;

    const idx = this._resolvePackageJson(absPath);
    if (idx) return idx;

    const indexPath = path.join(absPath, 'index');
    return this._tryExtensions(indexPath);
  }

  _tryExtensions(filePath) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return path.normalize(filePath);
    }
    for (const ext of this.extensions) {
      const p = filePath + ext;
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return path.normalize(p);
      }
    }
    return null;
  }

  _resolvePackageJson(dirPath) {
    const pjPath = path.join(dirPath, 'package.json');
    if (!fs.existsSync(pjPath)) return null;

    try {
      const pkg = JSON.parse(fs.readFileSync(pjPath, 'utf-8'));
      const entryFields = ['module', 'es2015', 'main'];
      for (const field of entryFields) {
        if (pkg[field]) {
          const entry = path.resolve(dirPath, pkg[field]);
          const resolved = this._tryExtensions(entry) || this._tryExtensions(path.join(entry, 'index'));
          if (resolved) return resolved;
        }
      }
    } catch {}
    return null;
  }

  parse(filePath) {
    const code = fs.readFileSync(filePath, 'utf-8');
    const ast = acorn.parse(code, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      locations: true,
    });

    const imports = [];
    const exports = [];
    const dynamicImports = [];

    const extractStaticImport = (node) => {
      const specifiers = [];
      let isDefault = false;
      let isNamespace = false;
      let importAllAs = null;
      let importDefaultAs = null;

      if (node.specifiers) {
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportDefaultSpecifier') {
            isDefault = true;
            importDefaultAs = spec.local.name;
            specifiers.push({
              local: spec.local.name,
              imported: 'default',
              type: 'default',
            });
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            isNamespace = true;
            importAllAs = spec.local.name;
            specifiers.push({
              local: spec.local.name,
              imported: '*',
              type: 'namespace',
            });
          } else if (spec.type === 'ImportSpecifier') {
            specifiers.push({
              local: spec.local.name,
              imported: spec.imported.name,
              type: 'named',
            });
          }
        }
      }

      return {
        source: node.source.value,
        specifiers,
        isDefault,
        isNamespace,
        importAllAs,
        importDefaultAs,
        loc: node.loc,
      };
    };

    const extractExport = (node) => {
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          if (node.declaration.type === 'FunctionDeclaration') {
            return {
              name: node.declaration.id.name,
              type: 'named',
              local: node.declaration.id.name,
              loc: node.loc,
              nodeType: 'function',
            };
          }
          if (node.declaration.type === 'ClassDeclaration') {
            return {
              name: node.declaration.id.name,
              type: 'named',
              local: node.declaration.id.name,
              loc: node.loc,
              nodeType: 'class',
            };
          }
          if (node.declaration.type === 'VariableDeclaration') {
            return node.declaration.declarations.map((d) => ({
              name: d.id.name,
              type: 'named',
              local: d.id.name,
              loc: node.loc,
              nodeType: 'variable',
            }));
          }
        }
        if (node.specifiers && node.specifiers.length > 0) {
          return node.specifiers.map((spec) => ({
            name: spec.exported.name,
            type: 'named',
            local: spec.local.name,
            loc: node.loc,
            nodeType: 'reexport',
            source: node.source ? node.source.value : null,
          }));
        }
      }

      if (node.type === 'ExportDefaultDeclaration') {
        const name =
          node.declaration.type === 'Identifier'
            ? node.declaration.name
            : 'default';
        return {
          name: 'default',
          type: 'default',
          local: name,
          loc: node.loc,
          nodeType: 'default',
        };
      }

      if (node.type === 'ExportAllDeclaration') {
        return {
          name: '*',
          type: 'all',
          source: node.source.value,
          loc: node.loc,
          nodeType: 'reexport-all',
        };
      }

      return null;
    };

    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        imports.push(extractStaticImport(node));
      } else if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee && node.callee.type === 'Import')) {
        if (node.source && node.source.type === 'Literal') {
          dynamicImports.push({
            source: node.source.value,
            loc: node.loc,
          });
        } else if (node.arguments && node.arguments[0] && node.arguments[0].type === 'Literal') {
          dynamicImports.push({
            source: node.arguments[0].value,
            loc: node.loc,
          });
        }
      } else if (
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportDefaultDeclaration' ||
        node.type === 'ExportAllDeclaration'
      ) {
        const exp = extractExport(node);
        if (exp) {
          if (Array.isArray(exp)) exports.push(...exp);
          else exports.push(exp);
        }
      }
    }

    walk.simple(ast, {
      ImportExpression(node) {
        if (node.source && node.source.type === 'Literal') {
          dynamicImports.push({
            source: node.source.value,
            loc: node.loc,
          });
        }
      },
    });

    const resolveImport = (imp) => {
      try {
        return this.resolve(imp.source, filePath);
      } catch {
        return null;
      }
    };

    const resolvedImports = imports
      .map((imp) => ({ ...imp, resolvedPath: resolveImport(imp) }))
      .filter((imp) => imp.resolvedPath !== null);

    const resolvedDynamicImports = dynamicImports
      .map((imp) => ({ ...imp, resolvedPath: resolveImport(imp) }))
      .filter((imp) => imp.resolvedPath !== null);

    return {
      filePath,
      code,
      ast,
      imports: resolvedImports,
      exports,
      dynamicImports: resolvedDynamicImports,
    };
  }

  invalidate(filePath) {
    for (const [key, value] of this._cache.entries()) {
      if (value === filePath || key.includes(filePath)) {
        this._cache.delete(key);
      }
    }
  }

  clearCache() {
    this._cache.clear();
  }
}

module.exports = DependencyResolver;
