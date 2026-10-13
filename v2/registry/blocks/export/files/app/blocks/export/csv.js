// CSV (RFC 4180) writing and reading, with spreadsheet formula injection protection.
//
// Writing: a cell is quoted when it holds a quote, a comma, a line break or leading/trailing
// spaces; quotes are doubled. A text cell starting with = + - @, a tab or a carriage return is
// prefixed with a single quote, so Excel, LibreOffice and Google Sheets show it as text instead
// of running it as a formula (OWASP "CSV Injection"). Numbers and booleans are not text cells
// and are written as they are, so -5 stays a number.
//
// Reading: the inverse, including quoted line breaks, and the protective quote is removed again
// so a file exported here imports back to the same values.

const FORMULA = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** One cell. Objects and arrays become JSON, dates ISO 8601, null and undefined an empty cell. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (FORMULA.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line, CRLF terminated as RFC 4180 says. */
export const csvRow = (values) => `${values.map(csvCell).join(',')}\r\n`;

/** Undo the protective quote added by csvCell (only in front of a formula character). */
export const unprotect = (text) => (text.length > 1 && text[0] === "'" && FORMULA.test(text.slice(1)) ? text.slice(1) : text);

/**
 * Parse CSV text into rows of strings. Accepts CRLF or LF, quoted cells with "" escapes and
 * line breaks, and a UTF-8 byte order mark. Throws on an unterminated quote.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === '')) rows.push(row); // skip blank lines
    row = [];
  };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  if (quoted) throw new Error('Unterminated quoted cell');
  if (cell !== '' || row.length) endRow();
  return rows;
}
