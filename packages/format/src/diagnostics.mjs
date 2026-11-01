// Diagnostic collection: severity from code, de-duplication, deterministic sort.

/** @typedef {{code:string,severity:'error'|'warning'|'info',file:string,location:string,message:string}} Diagnostic */

const SEVERITY = { E: 'error', W: 'warning', I: 'info' };

const NATURAL_SPLIT = /(\d+)/;

/** Natural string comparison: digit runs compare numerically ("line 2" < "line 10"). */
export function naturalCompare(a, b) {
  const pa = a.split(NATURAL_SPLIT);
  const pb = b.split(NATURAL_SPLIT);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (i % 2 === 1) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d;
      if (pa[i].length !== pb[i].length) return pa[i].length - pb[i].length;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return pa.length - pb.length;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class Collector {
  constructor() {
    /** @type {Map<string, Diagnostic>} */
    this.map = new Map();
  }

  /**
   * @param {string} code
   * @param {string} file path relative to the validated root, forward slashes
   * @param {string} location field path, "line N", or ""
   * @param {string} message
   */
  add(code, file, location, message) {
    const key = `${code}\0${file}\0${location}`;
    if (this.map.has(key)) return;
    this.map.set(key, { code, severity: SEVERITY[code[0]], file, location, message });
  }

  /** @returns {Diagnostic[]} */
  sorted() {
    return [...this.map.values()].sort(
      (a, b) => cmp(a.file, b.file) || naturalCompare(a.location, b.location) || cmp(a.code, b.code),
    );
  }
}
