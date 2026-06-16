const { Buffer } = require('buffer');

class SourceMapGenerator {
  constructor(options = {}) {
    this.file = options.file || '';
    this.sourceRoot = options.sourceRoot || '';
    this.skipValidation = options.skipValidation || false;
    this._sources = [];
    this._sourcesContent = {};
    this._names = [];
    this._mappings = [];
    this._lastGeneratedLine = 1;
    this._lastGeneratedColumn = 0;
    this._lastSourceIndex = 0;
    this._lastOriginalLine = 1;
    this._lastOriginalColumn = 0;
    this._lastNameIndex = 0;
  }

  addMapping(args) {
    const {
      generated,
      original,
      source,
      name = null,
    } = args;

    if (!generated || !original || !source) return;

    const sourceIndex = this._getSourceIndex(source);
    const nameIndex = name !== null ? this._getNameIndex(name) : null;

    this._mappings.push({
      generatedLine: generated.line,
      generatedColumn: generated.column,
      originalLine: original.line,
      originalColumn: original.column,
      sourceIndex,
      nameIndex,
    });
  }

  addSourceContent(source, content) {
    this._sourcesContent[source] = content;
  }

  _getSourceIndex(source) {
    let idx = this._sources.indexOf(source);
    if (idx === -1) {
      idx = this._sources.length;
      this._sources.push(source);
    }
    return idx;
  }

  _getNameIndex(name) {
    let idx = this._names.indexOf(name);
    if (idx === -1) {
      idx = this._names.length;
      this._names.push(name);
    }
    return idx;
  }

  _encodeVLQ(value) {
    let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
    let encoded = '';
    const BASE64_CHARS =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    do {
      let digit = vlq & 0x1f;
      vlq >>>= 5;
      if (vlq > 0) digit |= 0x20;
      encoded += BASE64_CHARS[digit];
    } while (vlq > 0);

    return encoded;
  }

  _generateMappingsString() {
    const sorted = [...this._mappings].sort(
      (a, b) =>
        a.generatedLine - b.generatedLine ||
        a.generatedColumn - b.generatedColumn
    );

    let result = '';
    let prevLine = 1;
    let prevCol = 0;
    let prevSource = 0;
    let prevOrigLine = 1;
    let prevOrigCol = 0;
    let prevName = 0;

    let lineMappings = [];

    for (const m of sorted) {
      while (prevLine < m.generatedLine) {
        result += lineMappings.join(',') + ';';
        lineMappings = [];
        prevLine++;
        prevCol = 0;
      }

      const segments = [];

      segments.push(this._encodeVLQ(m.generatedColumn - prevCol));
      prevCol = m.generatedColumn;

      segments.push(this._encodeVLQ(m.sourceIndex - prevSource));
      prevSource = m.sourceIndex;

      segments.push(this._encodeVLQ(m.originalLine - prevOrigLine));
      prevOrigLine = m.originalLine;

      segments.push(this._encodeVLQ(m.originalColumn - prevOrigCol));
      prevOrigCol = m.originalColumn;

      if (m.nameIndex !== null) {
        segments.push(this._encodeVLQ(m.nameIndex - prevName));
        prevName = m.nameIndex;
      }

      lineMappings.push(segments.join(''));
    }

    if (lineMappings.length > 0) {
      result += lineMappings.join(',');
    }

    return result;
  }

  toJSON() {
    const sourcesContent = this._sources.map(
      (s) => this._sourcesContent[s] || null
    );

    return {
      version: 3,
      file: this.file,
      sourceRoot: this.sourceRoot,
      sources: this._sources,
      names: this._names,
      mappings: this._generateMappingsString(),
      sourcesContent,
    };
  }

  toString() {
    return JSON.stringify(this.toJSON());
  }

  toBase64() {
    return Buffer.from(this.toString()).toString('base64');
  }

  toComment() {
    return `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${this.toBase64()}`;
  }
}

class SourceMapConsumer {
  constructor(sourceMap) {
    this._map =
      typeof sourceMap === 'string' ? JSON.parse(sourceMap) : sourceMap;
    this._decodedMappings = null;
  }

  get sources() {
    return this._map.sources;
  }

  get file() {
    return this._map.file;
  }

  originalPositionFor(generatedPosition) {
    if (!this._decodedMappings) {
      this._decodeMappings();
    }

    const { line, column } = generatedPosition;
    const mappings = this._decodedMappings[line];

    if (!mappings) return { source: null, line: null, column: null, name: null };

    let best = null;
    for (const m of mappings) {
      if (m.generatedColumn <= column) {
        best = m;
      } else {
        break;
      }
    }

    if (!best) return { source: null, line: null, column: null, name: null };

    return {
      source: this._map.sources[best.sourceIndex] || null,
      line: best.originalLine,
      column: best.originalColumn,
      name: this._map.names[best.nameIndex] || null,
    };
  }

  _decodeMappings() {
    this._decodedMappings = {};
    const VLQ_BASE_SHIFT = 5;
    const VLQ_BASE = 1 << VLQ_BASE_SHIFT;
    const VLQ_BASE_MASK = VLQ_BASE - 1;
    const VLQ_CONTINUATION_BIT = VLQ_BASE;

    const BASE64_CHARS =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const base64Map = {};
    for (let i = 0; i < BASE64_CHARS.length; i++) {
      base64Map[BASE64_CHARS[i]] = i;
    }

    const decodeVLQ = (str, index) => {
      let result = 0;
      let shift = 0;
      let continuation;

      do {
        const char = str[index++];
        if (char === undefined) return { value: 0, index };
        const digit = base64Map[char];
        if (digit === undefined) return { value: 0, index };
        continuation = !!(digit & VLQ_CONTINUATION_BIT);
        result += (digit & VLQ_BASE_MASK) << shift;
        shift += VLQ_BASE_SHIFT;
      } while (continuation);

      const isNegative = result & 1;
      result >>= 1;

      return {
        value: isNegative ? -result : result,
        index,
      };
    };

    const mappingsStr = this._map.mappings;
    let line = 1;
    let index = 0;
    let prevCol = 0;
    let prevSource = 0;
    let prevOrigLine = 1;
    let prevOrigCol = 0;
    let prevName = 0;

    while (index < mappingsStr.length) {
      if (!this._decodedMappings[line]) {
        this._decodedMappings[line] = [];
      }

      if (mappingsStr[index] === ';') {
        line++;
        prevCol = 0;
        index++;
        continue;
      }

      if (mappingsStr[index] === ',') {
        index++;
        continue;
      }

      const col = decodeVLQ(mappingsStr, index);
      index = col.index;
      const genCol = prevCol + col.value;
      prevCol = genCol;

      const src = decodeVLQ(mappingsStr, index);
      index = src.index;
      const sourceIdx = prevSource + src.value;
      prevSource = sourceIdx;

      const origLine = decodeVLQ(mappingsStr, index);
      index = origLine.index;
      const originalLine = prevOrigLine + origLine.value;
      prevOrigLine = originalLine;

      const origCol = decodeVLQ(mappingsStr, index);
      index = origCol.index;
      const originalCol = prevOrigCol + origCol.value;
      prevOrigCol = originalCol;

      let nameIdx = null;
      if (index < mappingsStr.length && mappingsStr[index] !== ',' && mappingsStr[index] !== ';') {
        const name = decodeVLQ(mappingsStr, index);
        index = name.index;
        nameIdx = prevName + name.value;
        prevName = nameIdx;
      }

      this._decodedMappings[line].push({
        generatedColumn: genCol,
        sourceIndex: sourceIdx,
        originalLine,
        originalColumn: originalCol,
        nameIndex: nameIdx,
      });
    }
  }
}

module.exports = { SourceMapGenerator, SourceMapConsumer };
