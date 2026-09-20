import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import SurgeClient from './client.js';
import DomainGenerator from './domain-generator.js';

class SurgeDeployment {
  constructor() {
    this.client = new SurgeClient();
  }

  async deploy(projectPath, domain = null, options = {}) {
    const absolutePath = path.resolve(projectPath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Project path does not exist: ${absolutePath}`);
    }

    const hasIndexHtml = fs.existsSync(path.join(absolutePath, 'index.html'));
    if (!hasIndexHtml && !options.force) {
      throw new Error('No index.html found in project directory. Use force: true to deploy anyway.');
    }

    if (!domain && options.generateDomain) {
      domain = DomainGenerator.generateWithSuffix();
    }

    return new Promise((resolve, reject) => {
      const args = ['--project', absolutePath];
      
      if (domain) {
        args.push('--domain', domain);
      }

      const deployProcess = spawn('surge', args, {
        stdio: 'inherit',
        cwd: absolutePath
      });

      deployProcess.on('close', (code) => {
        if (code === 0) {
          resolve({
            success: true,
            message: 'Deployment successful',
            path: absolutePath,
            domain: domain,
            url: domain ? `https://${domain}` : null
          });
        } else {
          reject(new Error(`Deployment failed with code ${code}`));
        }
      });

      deployProcess.on('error', (error) => {
        reject(new Error(`Deployment error: ${error.message}`));
      });
    });
  }

  createStaticSite(config) {
    const { 
      outputPath, 
      title = 'My Site', 
      content = '<h1>Welcome</h1>',
      styles = '',
      scripts = ''
    } = config;

    // Validate and sanitize inputs
    if (!outputPath || typeof outputPath !== 'string') {
      throw new Error('Invalid outputPath provided');
    }

    // Escape HTML content to prevent XSS
    const escapeHtml = (unsafe) => {
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };

    const safeTitle = escapeHtml(title);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    ${styles ? `<style>${styles}</style>` : ''}
</head>
<body>
    ${content}
    ${scripts ? `<script>${scripts}</script>` : ''}
</body>
</html>`;

    const absolutePath = path.resolve(outputPath);
    
    // Validate the path is safe (basic check against directory traversal)
    if (!absolutePath.includes(process.cwd()) && !absolutePath.includes('/tmp') && !absolutePath.includes('temp')) {
      console.warn(`Warning: Creating directory outside project root: ${absolutePath}`);
    }
    
    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
    }

    fs.writeFileSync(path.join(absolutePath, 'index.html'), html);
    
    if (config.additionalFiles) {
      for (const [filename, fileContent] of Object.entries(config.additionalFiles)) {
        // Validate filename to prevent path traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
          throw new Error(`Invalid filename: ${filename}`);
        }
        fs.writeFileSync(path.join(absolutePath, filename), fileContent);
      }
    }

    return {
      path: absolutePath,
      files: fs.readdirSync(absolutePath)
    };
  }

  async deployFromHtml(htmlContent, domain = null, tempDir = './temp-surge-deploy') {
    const site = this.createStaticSite({
      outputPath: tempDir,
      content: htmlContent
    });

    const isTemporary = tempDir.includes('temp');
    
    try {
      const result = await this.deploy(site.path, domain);
      
      if (isTemporary) {
        fs.rmSync(site.path, { recursive: true, force: true });
      }

      return result;
    } catch (error) {
      // Ensure cleanup happens even on failure
      if (isTemporary && fs.existsSync(site.path)) {
        try {
          fs.rmSync(site.path, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn(`Failed to cleanup temporary directory: ${cleanupError.message}`);
        }
      }
      throw error;
    }
  }

  async deployDataVisualization(data, config = {}) {
    const {
      title = 'Data Visualization',
      chartType = 'table',
      domain = null,
      tempDir = './temp-data-viz'
    } = config;

    let htmlContent = '';

    if (chartType === 'table' && Array.isArray(data)) {
      const headers = data.length > 0 ? Object.keys(data[0]) : [];
      
      htmlContent = `
        <h1>${title}</h1>
        <table border="1" style="border-collapse: collapse; width: 100%;">
          <thead>
            <tr>
              ${headers.map(h => `<th style="padding: 8px; background: #f0f0f0;">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${data.map(row => `
              <tr>
                ${headers.map(h => `<td style="padding: 8px;">${row[h] || ''}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } else if (chartType === 'json') {
      htmlContent = `
        <h1>${title}</h1>
        <pre style="background: #f5f5f5; padding: 20px; overflow: auto;">
${JSON.stringify(data, null, 2)}
        </pre>
      `;
    }

    const styles = `
      body {
        font-family: Arial, sans-serif;
        margin: 40px;
        background: white;
      }
      h1 {
        color: #333;
      }
    `;

    return await this.deployFromHtml(htmlContent, domain, tempDir);
  }
}

export default SurgeDeployment;