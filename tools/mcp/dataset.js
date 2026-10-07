import path from 'path';
import { isWithinDirectory, isSensitiveWorkspacePath } from '../server/security-utils.js';

/**
 * Resolve an MCP `dataset` argument to a CSV file inside data/.
 *
 * `dataset` comes from the model, and the model reads synced business data
 * that outsiders write (form leads, deal notes) — so treat it as hostile.
 * Without these checks `dataset: "../env.local"` returned the first rows of
 * the secrets file. A dataset is either data/<name>/ (first CSV inside) or
 * data/<name>.csv, and the file read must be a CSV that stays under data/.
 *
 * @param {string} dataPath Absolute path to the workspace data directory
 * @param {string} dataset Dataset name as supplied by the tool call
 * @returns {Promise<{filePath: string, isDirectory: boolean}>}
 */
export async function resolveDatasetCsv(dataPath, dataset) {
  const { readdir, stat } = await import('fs/promises');
  if (typeof dataset !== 'string' || !dataset.trim() || dataset.includes('\0')) {
    throw new Error('dataset must be a non-empty name');
  }

  const datasetPath = path.join(dataPath, dataset);
  let filePath;
  let isDirectory = false;
  try {
    const stats = await stat(datasetPath);
    if (stats.isDirectory()) {
      const csvFiles = (await readdir(datasetPath)).filter(f => f.endsWith('.csv'));
      if (csvFiles.length === 0) throw new Error(`No CSV files found in dataset directory: ${dataset}`);
      filePath = path.join(datasetPath, csvFiles[0]);
      isDirectory = true;
    } else {
      filePath = datasetPath;
    }
  } catch (error) {
    if (error.message.startsWith('No CSV files')) throw error;
    filePath = path.join(dataPath, `${dataset}.csv`);
    await stat(filePath); // throws if it doesn't exist
  }

  const relative = path.relative(path.dirname(dataPath), filePath);
  if (!isWithinDirectory(filePath, dataPath) || !filePath.toLowerCase().endsWith('.csv') || isSensitiveWorkspacePath(relative)) {
    throw new Error('dataset must name a CSV file inside data/');
  }
  return { filePath, isDirectory };
}
