// Edit env.local in place.
//
// The Settings dialog used to rebuild env.local from its KEY=value pairs, so
// every save dropped the user's comments, blank lines, ordering and anything
// else it didn't parse. This edits the text instead: only the lines for the
// keys being changed are touched.

const NEW_FILE_HEADER = '# LocalBase environment variables\n# Do not commit this file to version control\n\n';

// `KEY=…` or `export KEY=…`, not a comment. Captures the optional export prefix.
const assignment = (key) => new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=`);

/**
 * Apply changes to env file text.
 *
 * @param {string} content Current file content ('' when the file doesn't exist)
 * @param {Record<string, string|null>} changes Keys to set (string) or remove (null).
 *   Keys must already be validated; undefined and '' are ignored.
 * @returns {{content: string, updated: number, deleted: number}}
 */
export function updateEnvContent(content, changes) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  let lines = content === '' ? [] : content.split(/\r?\n/);
  // A trailing newline leaves one empty element; set it aside and restore it.
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();

  let updated = 0;
  let deleted = 0;
  const appended = [];

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === '') continue;
    const re = assignment(key);

    if (value === null) {
      const before = lines.length;
      lines = lines.filter(line => !re.test(line));
      if (lines.length !== before) deleted++;
      continue;
    }

    // Update every assignment of the key in place, so whichever one a loader
    // reads (first or last), it gets the new value.
    let found = false;
    lines = lines.map(line => {
      const match = line.match(re);
      if (!match) return line;
      found = true;
      return `${match[1]}${key}=${value}`;
    });
    if (!found) appended.push(`${key}=${value}`);
    updated++;
  }

  if (content === '') {
    return { content: NEW_FILE_HEADER + appended.map(l => l + '\n').join(''), updated, deleted };
  }
  const out = [...lines, ...appended];
  const text = out.join(eol) + (out.length && (hadTrailingNewline || appended.length) ? eol : '');
  return { content: text, updated, deleted };
}
